# 2026-04-19 evening — Gemma stack pivot + 2×2 ablation

## Headline

After ~5 hours of LM Studio harness iteration, we landed on a validated
full stack that **significantly outperforms the llama+qwen baseline we
started with** on both benchmarks. Phase B will run this stack at full
scale (LME n=500, LoCoMo n=200).

### Final stack

- **Gen:** `google/gemma-4-e4b` (Matformer 4B active, ~4 GB Q4_K_M)
  - parallel=8 ctx=131072 (16k per slot)
- **Judge:** `google/gemma-4-26b-a4b` (MoE 26B/4B active, ~17 GB Q4_K_M)
  - parallel=3 ctx=49152 (16k per slot)
- **Prompt:** v14 CoT (audit's `answer_prompt_cot` verbatim)
- **Judge mode:** strict (audit-corrected, drops the lenient "touches on topic" clause)
- **Cache:** separate `llm-cache-gemma.json` per benchmark

## Smoke results (2×2×2 matrix)

### LME (n=20)

| Config | Judge | n | dropouts |
|---|---|---|---|
| Llama+qwen v11 | 61.1% | 18 | 2 |
| Llama+qwen v14 CoT | 57.9% | 19 | 1 |
| Gemma+gemma v11 | **70.0%** | 20 | **0** |
| Gemma+gemma v14 CoT | **80.0%** | 20 | **0** |

### LoCoMo (n=50)

| | v11 | v14 CoT | judge leniency inflation |
|---|---|---|---|
| llama+qwen lenient | 46.9% (49) | 61.4% (44) | |
| llama+qwen strict | 19.4% (36) | 38.5% (39) | **+23–27pp** |
| gemma+gemma lenient | 61.4% (44) | — | |
| gemma+gemma strict | — | 51.2% (43) | |
| CoT effect (strict) | — | **+19.1pp** | |

## Findings that shape Phase B

1. **v14 CoT is real** — +10–19pp over v11 once n is large enough to see it (initial LME n=20 noise obscured).
2. **Lenient judge inflates by ~25pp** — the audit's "touches on topic" leniency critique replicates at eval scale. All prior LoCoMo numbers are inflated. Strict judge is correct baseline going forward.
3. **Gemma stack > llama+qwen** by 9–15pp on identical prompts/data. Gemma-e4b produces higher-quality answers despite being smaller than llama-8B, and gemma judge emits clean JSON where qwen had 3 unparseables across 39.

## Gotchas collected today

See `devnotes/architecture/testing-runbook.md` "Recipe 8 LM Studio" section
for the full list. Highlights:

1. `context_length` on LM Studio `/api/v1/models/load` is **total across
   parallel slots**, not per-slot. Per-slot = context_length / parallel.
2. LM Studio doesn't auto-evict models on load → must unload the OTHER
   model explicitly before loading a new one (cross-model unload).
3. **3s VRAM-release settle between unload/load is load-bearing.** Without
   it, unload returns before driver reclaims VRAM → next load briefly
   oversubscribes → LM Studio crashes (hit this 3× today).
4. Thinking models (qwen, gemma-4-e4b) burn reasoning tokens before
   emitting content. `LOTL_ANSWER_MAX_TOKENS` is a floor that bumps v11's
   128 default to something like 1536 while keeping v14's 2560 default.
5. llm-cache hash doesn't include max_tokens (reverted after a failed
   attempt broke all existing entries). Workaround: separate cache file
   per model stack via `LOTL_LLM_CACHE_PATH`.
6. Don't run two smoke scripts concurrently — they issue conflicting
   load/unload to the same LM Studio.

## Known issues (non-blocking for Phase B)

- **Gemma judge has 6–7 dropouts per 50 LoCoMo questions.** Prompt-format
  sensitivity on longer inputs. Solvable via a retry pass or more robust
  JSON parsing. Logged for post-Phase-B cleanup.
- **One LoCoMo question consistently cache-misses** (q2 of the rejudge
  path). Original pair 4 gen failed on that question (fetch-fail), never
  cached. Rejudge tries to regenerate → llama auto-load at default
  ctx=4096 → overflow → fallback. Cosmetic, doesn't affect totals.

## Phase B runner

`evaluate/scripts/phase-b-gemma.sh` — LME n=500 + LoCoMo --limit 20 × 10
convs = 200 questions. Expected wall ~40–50 min. Separate gemma cache,
3s VRAM settle, single-instance guarantee, strict judge.

## Stage 9 rerank sweep (independent overnight job)

Running on the local workstation (not the LM Studio box). Last observed:
- baseline ✓, jina-tiny-w73 ✓ (+4.9pp R@5), jina-turbo-w73 ✓, mxbai-xsmall-w73 running
- 3 bigger rerankers (mxbai-base, gte-modernbert, tomaarsen) queued,
  will grind through the night per prior decision to let them run.

## Phase B actual results (landed 2026-04-19 20:11, wall 2h10m)

### LME n=500 gemma v14 CoT strict

| Metric | Value |
|---|---|
| Judge accuracy | **40.3%** (176/437 judged) |
| Dropouts | 63 (12.6%) |
| F1 | 13.3% |
| rAny@5 | 97.4% |
| R@5 | 88.4% |

### LoCoMo n=200 gemma v14 CoT strict

| Metric | Value |
|---|---|
| Judge accuracy | **44.7%** (80/179 judged) |
| Dropouts | 21 (10.5%) |
| F1 | 13.9% |
| rAny@5 | 73.5% |
| R@5 | 49.5% |

### Smoke-vs-scale regression (critical finding)

| Config | Smoke n | Smoke % | Phase B n | Phase B % | Δ |
|---|---|---|---|---|---|
| LME gemma v14 | 20 | 80.0 | 437 | 40.3 | **−39.7pp** |
| LoCoMo gemma v14 strict | 43 | 51.2 | 179 | 44.7 | −6.5pp |

LME smoke landed on an unusually-easy subset (temporal-reasoning only —
`longmemeval_oracle.json` first 20 are all temporal). At real scale the
question-type mix brings it down. LoCoMo less dramatic because 50
questions span all 10 convs already.

### Fair at-scale comparison (LoCoMo v14 strict, only same-n match we have)

| Stack | n | Judge % |
|---|---|---|
| Llama+qwen | 39 | 38.5 |
| **Gemma+gemma** | **179** | **44.7** |

Gemma wins ~6pp at scale on LoCoMo. Margin smaller than the smoke
suggested (was ~15pp). LME needs a llama+qwen n=500 run for a fair
cross-stack comparison — we don't have that yet.

### Retrieval findings

- **LME rAny@5 = 97.4%** at n=500 — retrieval ceiling-bound. Audit's
  point exactly: LME doesn't discriminate systems at retrieval layer.
- **LoCoMo R@5 = 49.5%** — matches baseline from rerank sweep (52%).
  Room to discriminate here.
- **F1 ~13% on both** — predictions phrase things differently from gold
  tokens. Judge catches equivalence at ~40–45%. F1 is a noisy proxy;
  judge is the real metric.

## Takeaways

1. **Smoke must be ≥100 questions per cell.** Anything smaller is
   unreliable. Audit's methodology validated empirically.
2. **Gemma wins LoCoMo by ~6pp at scale** (not 15pp). Still real.
3. **Gemma judge drops 10–13% at scale** — retry pass or schema-forcing
   prompt needed.
4. **LME retrieval is ceiling-bound** (97.4% rAny@5). Future LME
   improvement must come from answer-gen.
5. **LME llama+qwen at n=500 still needed** for fair cross-stack claim.

## Open tasks after Phase B

1. Compile final report + update `devnotes/metrics/`
2. Patch gemma judge JSON dropouts (retry pass or schema-forcing prompt)
3. Run llama+qwen LME n=500 for fair cross-stack comparison on LME
4. Update published LoCoMo baselines — current numbers are lenient-inflated
5. Decide whether to retire qwen/llama stack entirely or keep as
   reproducibility reference

