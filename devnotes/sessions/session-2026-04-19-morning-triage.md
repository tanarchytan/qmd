# Morning triage runbook — 2026-04-19

You slept. A lot happened overnight. Read this first; everything else is
supporting material.

## 30-second top line

- ✅ **No MRR code regression.** The 0.917 in SNAPSHOTS.md didn't reproduce
  and never did — bisect across 3 commits confirms. Pre-rename code was
  WORSE. Current code + 0.907 MRR is the real number.
- ✅ **Reranker filename bug** fixed (all prior rerank data invalid).
- ✅ **Reranker 67 GB OOM** on ModernBERT fixed (max_length=512 cap).
- ⚡ **Eval TOUCH-contamination bug** fixed — this is the biggest one.
  Every cross-config A/B that shared a DB was silently biased.
- ⚠️ **Big-param rerankers parked overnight** — small-only pass first.

## Reading order (5 min)

1. This doc (runbook).
2. `evaluate/sweeps/chain-*/MASTER.md` — main chain stages 1-6.
3. `evaluate/sweeps/followup-*/MASTER.md` — stages 7-14.
4. `evaluate/sweeps/reruns-*/MASTER.md` — R1-R5 reruns with all fixes live.
5. `devnotes/sessions/session-2026-04-19-overnight-sweeps.md` — detailed diary.
6. `devnotes/architecture/env-flag-polarity-reference.md` — new reference for
   every LOTL_* flag's polarity. Bookmark this.

## Trust map — which results to believe

**Contaminated (TOUCH bias; interpret deltas as upper bounds):**
- Phase 1 LME flag sweep (earlier session)
- Main chain Stage 3 LoCoMo flag × weight
- Main chain Stages 2, 4, 6 (also rerank-silent-no-op'd on top of TOUCH)
- Follow-up Stages 7 (hung), 8 (1-config only), 9-14 (9 onward was with
  rerank fix but still without TOUCH fix until after commit `b2c0f62`)

**Clean (both fixes live):**
- Reruns chain R1-R5 — `sweep-flags.sh` exports `LOTL_RECALL_NO_TOUCH=on`
  and uses fixed rerank backend.

## Tomorrow-morning action checklist

### 1. Verify reruns completed OK
```sh
ls evaluate/sweeps/reruns-*/MASTER.md
```
Expect all 5 stages green. If any failed, read its log before proceeding.

### 2. Pull the key numbers

```sh
for d in evaluate/sweeps/reruns-*/*/; do
  [[ -f "$d/lme.json" ]] && node -e "const j=JSON.parse(require('fs').readFileSync('$d/lme.json','utf8'));console.log('$(basename $d)'.padEnd(30), 'MRR', j.summary.avgMRR, 'rAny@5', j.summary.avgRAny5)"
done
```

### 3. Answer the big questions

- **Did ANY reranker beat baseline MRR by ≥0.005?** (R2/R3/R4 data)
  - If yes → rerank enabled by default becomes worth it. Land the
    `STRONG_SIGNAL_SKIP=on` check for wall-time sanity. Revisit bigger
    parked models (184M mxbai-base, 149M gte-modernbert) only if
    small-model signal is strong.
  - If no → RRF score normalization (src/store/constants.ts:67-74 KNOWN
    LIMITATION) is the blocker. Implement that before more model A/Bs.

- **Does LoCoMo (harder corpus) show any flag signal?** (R1 data)
  - LME was ceiling-bound. LoCoMo has room (R@5 ~50-60%).
  - Specifically check: does `expand=entities` help LoCoMo? Does
    `vec-min-sim-off` help?

- **Did `combined-winners` (R5) produce a new v1 ship number?**
  - If R5 MRR ≥ baseline + rerank-wins stacked → update `evaluate/SNAPSHOTS.md`
    with the new canonical numbers for v1 ship.

### 4. Phase 4 graduation decisions (informed by clean data)

Ready-to-apply kill list (after R1 confirms no LoCoMo signal):

- **Delete `LOTL_MEMORY_LHASH`** — 55-line block in `src/memory/index.ts:1472-1526`,
  plus the `MEMORY_L0/L1/L2_WEIGHT` constants. Already strongly kill-candidate:
  crashed LoCoMo R@5 15.5% on Stage 3.
- **Delete `LOTL_RECALL_DIVERSIFY`** — single-line OR'd with MMR=session
  at `src/memory/index.ts:1664`. Overlapping functionality.
- **Keep `LOTL_MEMORY_MMR=session`** pending Judge-Acc signal.
- **Keep `LOTL_MEMORY_EXPAND=entities`** — mildly positive on prior runs.
- **Keep `LOTL_VEC_MIN_SIM`** — load-bearing in vec-heavy regimes.

### 5. Update SNAPSHOTS.md with clean numbers

After reruns land, replace the 2026-04-18 table entries with 2026-04-19
values. Keep the historical 0.917 footnote for audit trail.

### 6. MRR drift — close with no action

The drift was a phantom. Don't bisect. Update SNAPSHOTS.md baseline to
0.907 and move on. See session-2026-04-19-overnight-sweeps.md for the
three-commit bisect data.

## Fixes landed overnight (commits on dev)

```
b2c0f62  LOTL_RECALL_NO_TOUCH env guard (eval-confound fix)
9be3392  docs: session handoff notes the TOUCH finding
e7058ee  close MRR drift investigation — phantom
52db694  reruns-chain.sh for stages 2/4/6/7/8
f766f9d  rerank max_length=512 OOM fix
9cba9bc  rerank filename auto-resolve for non-legacy models
8a2b289  stage 14 polarity-corrected + MRR bisect helper
929dfe2  stages 12-13 + Phase 5 design draft
fea97fd  follow-up stages 7-11 scaffolding
13e3f97  Phase 0-6 optimization scaffolding + Phase 1 findings
ba4f062  park rerankers >100M
```

## Deferred — for after today's triage

- **Phase 5 implementation** (KG + fact-aug keys). Design doc exists
  (`devnotes/architecture/phase5-kg-and-fact-aug-design.md`). Needs your
  sign-off on schema migration before any code lands.
- **Big-param reranker retest** — only if small-model rerank signal is
  strong enough to justify the compute cost. Uncomment the parked rows
  in `evaluate/sweeps/configs/reranker-sweep-phase3.txt`.
- **Stage 3 anomaly postmortem** — unnecessary now, explained by TOUCH bug.
- **Eval-harness audit extension** — we ruled out other recall-time
  mutations. `consolidateEntityFacts` and `runDecayPass` happen at
  ingest time only (cached across sweeps via DB suffix), so they don't
  bias A/B. No further audit needed unless new surprises appear.
