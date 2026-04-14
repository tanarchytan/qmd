# Phase 5 — wiring sweep on shipped-but-untested features

**Goal:** validate or rule out the §0 features in `docs/TODO.md` that already
exist in `src/memory/index.ts` but have never been benchmarked on LME _s n=500.
Each is either a flag flip or a small RAW-gate lift. None require new
retrieval logic.

**Why this is the highest-leverage night work:**
- Phase 4 (in flight) tests three combinations of model × levers we built
  tonight. If it plateaus, we'd otherwise pivot to building cross-encoder
  rerank — which is ~80 lines of new code + a model download.
- Phase 5 attacks the same multi-session ceiling using **code that's already
  written and committed**. Worst case = N null results, zero new bugs, fully
  understood baselines for v17 planning.

---

## Honest inventory: what each shipped feature actually is

Audit done 2026-04-14. **Not every §0 entry is a flag flip** — some are APIs
that the eval harness doesn't call. Categorizing by what would be needed to
test on LME _s.

### Class A — pure flag flip (no code change)

| Feature | Flag | Test |
|---|---|---|
| Per-turn ingest | `QMD_INGEST_PER_TURN=on` | n=500 mxbai-xs q8 (and arctic-s) |

That's it for class A. Per-turn already has the eval-harness branch; everything
else needs at least a one-line gate lift.

### Class B — one-line gate lift, then flag flip

| Feature | Current gate | Fix needed | Test |
|---|---|---|---|
| Smart KG-in-recall | `if (!RAW && QMD_RECALL_KG === "on")` (`index.ts:1169`) | Add `QMD_RECALL_KG_RAW=on` escape hatch (same pattern as tonight's MMR fix) | n=500 mxbai-xs q8 + KG |
| Tier-filtered recall | No env reader on `memoryRecall(tier)` option | Add `QMD_RECALL_TIER=core,working` env reader | **Skip — newly-ingested memories all default to `peripheral`, so tier filter is a noop on a fresh LME ingest.** Would need ingest-time tier promotion or a separate decay pass first. Not worth the wire for this phase. |
| Dialog diversity (`QMD_RECALL_DIVERSIFY`) | `!RAW &&` | Already lifted tonight via `QMD_MEMORY_MMR=session` | Already in phase 4 |

### Class C — eval-harness wiring (10-30 lines in `evaluate/longmemeval/eval.mts`)

| Feature | API | Wire point |
|---|---|---|
| Hindsight reflect synthesis (`memoryReflect`) | Takes `query` + `memories` → returns synthesized context. | After `memoryRecall`, before answer formatting. Adds 1 LLM call per question. **Not RAW-compatible** — uses LLM. Skip for RAW eval but worth a non-RAW run for the answer-quality category. |
| Periodic reflection (`runReflectionPass`) | Pre-ingest pass that derives meta-memories. | Run between ingest and query phases. Each scope gets new reflection memories that downstream queries can hit. **Not RAW-compatible** — uses LLM. Skip. |
| Push Pack (`pushPack`) | Returns Task State + hot tail + time markers. | Designed for session priming, not single-question retrieval. **Wrong shape for LME** — not a recall replacement. Skip. |

### Class D — needs schema/ingest-time work

| Feature | Why it can't be flag-flipped |
|---|---|
| Tier-grouped recall as a real lever | Tier promotion happens via `evaluateTier()` based on access counts + age. Fresh LME ingest has neither → all memories are `peripheral` → tier filter does nothing. To make this useful: either pre-promote during ingest based on importance, or run `runDecayPass` synthetically before queries. |

---

## Phase 5 actual scope

After honest audit, **only two experiments are practical** for phase 5 within
the night budget:

### 5.1 — per-turn ingest A/B at n=500

**Hypothesis:** finer-grained memories (5-10 per session × 50 sessions = ~500
per scope vs current ~50) give multi-session questions a better chance of
landing supporting facts in top-5.

**Risk:** 10x more candidates → cosine distribution flattens → top-1 drops →
adaptive floor drops → larger candidate pool but lower overall similarity →
reranking becomes harder. Could swing either way.

**Runs:**
1. `n500-mxbai-perturn`: mxbai-xs q8 + `QMD_INGEST_PER_TURN=on`
2. `n500-arctic-s-perturn`: arctic-s q8 + `QMD_INGEST_PER_TURN=on`
3. **If 5.1 #1 or #2 shows ≥+1pp multi-session:** stack with the phase-4
   winning levers (loose floor + expand-kw + MMR if MMR moves anything)

**Wall:** ~15-25 min per run. ~30-50 min total for 5.1.

### 5.2 — KG-in-recall RAW lift + A/B

**Hypothesis:** the v16 KG smart gating (3 conditions: opt-in, ≥1 entity, top
score < 0.3) was designed exactly to avoid the v8 blunt-injection failure mode.
The third condition (`top score < 0.3`) means it only fires when the main
pipeline came up short — directly attacks the multi-session "right answer not
in top-5" failure mode. Never tested at n=500 because RAW gate blocks it.

**Code change required:** lift the RAW gate or add a `QMD_RECALL_KG_RAW=on`
flag (same pattern as the MMR fix in commit `1def426`). ~3 lines.

**Caveat:** the gating condition `topScore < 0.3` may rarely fire on
mxbai-xs q8 because top scores are tightly clustered around 0.6-0.8.
Worth running anyway to confirm. If it never fires, the run is identical
to baseline — that's a fine outcome too (proves the gate is doing its job).

**Runs:**
1. `n500-mxbai-kg`: mxbai-xs q8 + `QMD_RECALL_KG_RAW=on`
2. **If 5.2 #1 shows movement:** arctic-s q8 + KG.

**Wall:** ~15-25 min per run. ~15-50 min total for 5.2.

### 5.3 — combined (only if 5.1 or 5.2 shows signal)

**Hypothesis:** if per-turn lifts multi-session via finer chunks, AND KG-in-
recall lifts via entity injection on weak hits, they attack different failure
modes and may be additive.

**Run:** best-of-5.1-5.2 stacked: per-turn + KG + expand-kw + (MMR if phase 4
showed signal). On the winning model from phase 4.

**Wall:** ~15-25 min.

---

## Decision matrix folding in phase 4 + phase 5

Phase 4 outcome A — **fixed MMR moves multi-session ≥+1pp:**
- Implies session diversity is a lever. Promote `QMD_MEMORY_MMR=session` to
  default for the bottleneck-priority workload. Stack into 5.3.

Phase 4 outcome B — **arctic-s + expand-kw breaks 85% multi-session:**
- Confirms the model + decomposition combo. Promote arctic-s q8 to a first-
  class config in `.env.example`. Stack into 5.3 with per-turn.

Phase 4 outcome C — **all phase 4 runs flat at ~83-84%:**
- The remaining gap is not a session-diversity / expansion problem on the
  current pipeline shape. Phase 5 becomes the last shot before pivoting to
  cross-encoder rerank work in v17.

Phase 5 outcome 1 — **per-turn lifts multi-session:**
- Promote `QMD_INGEST_PER_TURN=on` to default for memory-system workloads.
  Caveat: storage cost ~10x. Document the tradeoff.

Phase 5 outcome 2 — **per-turn hurts overall R@5:**
- Document as a knob, leave default off. The granularity tradeoff went the
  other way.

Phase 5 outcome 3 — **KG-in-recall lifts multi-session:**
- The smart-gating fix is validated. Promote `QMD_RECALL_KG_RAW=on` (or
  un-gate fully) and update v16 ROADMAP entry to "shipped, validated".

Phase 5 outcome 4 — **all phase 5 runs flat:**
- The 82-84% multi-session ceiling is not breakable with anything we have
  shipped. v17 priorities are then: cross-encoder rerank (#1), 4-parallel-
  path retrieval (#2), schema-level tier promotion (#3).

---

## Execution sequence

1. Wait for phase 4 to finish (currently running, ~55 min from launch).
2. Apply phase 4 results to the decision matrix above.
3. Phase 5 prep: **lift the KG RAW gate in `index.ts:1169`** (one edit, one
   commit). This unblocks 5.2 with no other code changes.
4. Write `evaluate/run-night-phase5.sh` mirroring the phase 4 chain pattern.
5. Launch phase 5 chain: 5.1 #1, 5.1 #2, 5.2 #1, [conditional] 5.3.
6. Schedule wakeup for ~75-90 min after launch.
7. On wake: parse all results, update `docs/TODO.md` §0 entries with new
   verdicts, write the night summary into `docs/ROADMAP.md`, commit.

---

## Time budget

- Phase 4 (in flight): ~55 min total wall
- Phase 5.1 + 5.2 + 5.3 conditional: ~60-90 min wall
- Roadmap writeup + commits: ~10 min

**Phase 4 + Phase 5 + writeup ≈ 2-2.5 hours** from now (06:30 CEST). Done by
~09:00 CEST. Then a final sleep until the user picks up.

---

## Auto-kills and stop conditions

- Per-run watchdog: 2100s (35 min). Anything stalled gets killed silently and
  flagged in the summary as "incomplete".
- Hard stop: if phase 5.1 first run errors with an OOM or schema bug, abort
  the chain and leave the working tree clean. Per-turn ingest changes the
  dbs schema and is the most likely place for a runtime surprise.
- Soft stop: if all phase 5.1 + 5.2 runs are within ±0.5pp of the phase 3
  baseline (94.2% R@5 / 82% multi), declare null and queue v17 cross-encoder
  rerank as the next experiment in the morning briefing.

---

## What the user gets when they wake up

A single commit message that says "phase 4 + phase 5 done" with:
- Phase 4 verdict (3 runs)
- Phase 5 verdict (2-4 runs)
- Updated `docs/TODO.md` §0 — every shipped-but-untested item now marked
  validated, null-result, or still-untested-because-eval-shape.
- Updated `docs/ROADMAP.md` night session with the full table and v17
  pointer.
- Working tree clean. No surprises.

If something blocked the chain mid-flight, instead of a clean commit the
user gets a short summary of what failed and which items still need a run.
