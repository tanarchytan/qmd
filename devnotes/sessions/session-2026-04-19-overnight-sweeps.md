# Overnight sweep session — 2026-04-19

**Status at bedtime (01:30 approx):** main chain (bkb4go86h) complete, follow-up
(bs4wjrdqv) running. ~3 h remaining compute.

## Key findings (tomorrow's triage order)

### 🔴 MRR drift is deterministic — bisect tomorrow

Stage 5 of main chain ran 5 identical LME n=500 baseline passes. Every single
run produced **MRR 0.907 / rAny@5 97.8% / R@5 93.4%** — byte-identical.

SNAPSHOTS.md pinned 0.917 MRR on this exact corpus / embed config. Drift is
**real code drift**, not bench noise.

**Action:** `git bisect` between the SNAPSHOTS commit and current HEAD using
`evaluate/scripts/mrr-drift-bisect.sh`. Helper is ready, needs a good commit
hash (the one that produced 0.917 on the SNAPSHOTS pin). Probable window:
the 8-commit "refactor(cli)" series or the qmd→lotl rename commit.

### 🔴 All reranker data is INVALID — fixed, needs rerun

**Stages 2, 4, 6, 7 (partial) all silently no-op'd the reranker.** Every
candidate produced byte-identical metrics to baseline because the factory
hardcoded `model_quint8_avx2` as the ONNX filename — only the legacy
`cross-encoder/ms-marco-MiniLM-L6-v2` ships that variant.

Error in logs: `"Memory rerank failed: Could not locate file ..."` — fell
through to fusion-only ranking silently.

**Fixed in `9cba9bc`:** when user specifies a non-default model, don't
inherit legacy filename/dtype. Let transformers.js resolve /onnx/ from the
repo and pass `dtype=q8`.

**Action tomorrow:**
1. Rerun Phase 3 reranker A/B on LME + LoCoMo (stages 2, 4 equivalents)
2. Rerun Stage 6 combined-winners — the auto-picked "tomaarsen-modernbert"
   was selected on invalid data

### 🟡 LoCoMo flag × weight (Stage 3) — partially valid

Stage 3 didn't use rerankers so the data is valid. Highlights:

- **`LHASH` crashes on LoCoMo** at both 9/1 and 1/9 weights:
  R@5 15.5% (vs baseline 57.2%). Confirms LHASH is a strong Phase 4 delete
  candidate — it's not just null on LME, it actively breaks LoCoMo.
- **1/9 (extreme vec) drops R@5 by ~7pp** across all flags — consistent
  with the LME finding that mxbai-xs vec signal isn't strong enough to
  dominate RRF.
- **Wall-time anomaly**: baseline took 273s but every subsequent config
  took 38-42s. Suggests baseline did the LoCoMo ingest and subsequent runs
  reused the DB. Consistent with LoCoMo eval behavior.
- **Scores differ between baseline (R@5=57.2%) and baseline-w91 (R@5=52.7%)
  despite identical weights.** Unexplained. Possibly ingest vs non-ingest
  state affects first-pass scoring. Worth a targeted investigation.

### 🟢 Running (follow-up bs4wjrdqv, started 01:11)

Stages 7-14 queued. 7 started at 01:11:19. Remaining stages:

7. LME reranker × 7/3 weight — partially invalid if started before fix
   commit (9cba9bc, 01:14), valid after
8. LoCoMo Phase 1 single-flag ablation — rerun of null-on-LME on harder corpus
9. LoCoMo reranker × 7/3 weight — should benefit from fix
10. LoCoMo MRR drift 5-pass repro — will show if drift is LoCoMo-specific
11. Combined winners on LoCoMo — based on Stage 6 which was invalid
12. All-flags stacked (LME + LoCoMo)
13. LLM-judge A/B (n=100, gemini) — content-flag effects on Judge-Acc
14. Polarity-corrected rerun (synonyms=off, scope-norm=rank, expand=none)

### 🟢 Infrastructure committed

- `scripts/mrr-drift-bisect.sh` — git-bisect runner
- `scripts/sweep-flags-llm.sh` — LLM-judge sweep runner
- `scripts/follow-up-sweeps.sh` — 8-stage follow-up chain
- `devnotes/architecture/phase5-kg-and-fact-aug-design.md` — Phase 5 design,
  not implemented, needs sign-off

### 🟡 Gotchas caught this session

1. **Flag polarity bugs** — Phase 1 silently tested 3 no-ops:
   `LOTL_MEMORY_SYNONYMS=on` (default on), `LOTL_MEMORY_SCOPE_NORM=on`
   (needs `=rank`), `LOTL_MEMORY_EXPAND=keywords` (IS the default). Fixed
   in Stage 14.
2. **Reranker default filename** — caught via silent-no-op pattern, fixed.
3. **sweep-flags.sh `env $overlay`** — correctly space-splits multi-var
   overlays. No bug, just note.

## Tomorrow's ordered action list

1. Git bisect the MRR drift (mrr-drift-bisect.sh is ready)
2. Read the follow-up `MASTER.md` once it lands
3. Rerun Phase 3 reranker A/B with fix in place (LME + LoCoMo)
4. Once reranker winner is known, rerun combined-winners
5. Triage Stage 14 corrected-polarity results — does `synonyms=off` change
   behavior? `scope-norm=rank`?
6. Phase 4 graduation PR draft based on combined signal
7. User sign-off on Phase 5 design before any schema migration
