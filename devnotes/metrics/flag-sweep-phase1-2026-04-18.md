# Phase 1 flag-impact sweep — 2026-04-18

**Corpus:** LongMemEval n=500 (`lme-s-mxbai-n500-v17.sqlite` pre-populated).
**Embedder:** mxbai-embed-xsmall-v1 q8. **Workers:** 4 / `OMP_NUM_THREADS=4` / `LOTL_EMBED_MAX_WORKERS=4` / `LOTL_EMBED_MICROBATCH=32`.
**Script:** `evaluate/scripts/sweep-flags.sh evaluate/sweeps/configs/flag-sweep-phase1.txt`
**Run:** `evaluate/sweeps/flag-sweep-phase1-20260418-232607/` (single-flag ablation, 9 configs).

## Headline: null result across the board — BUT 3 of 9 tests were invalid

No flag moves MRR by ≥0.005 or rAny@5 by ≥0.3pp. Every delta is inside the
measurement noise floor.

**Correction (2026-04-19):** audit revealed 3 of the 9 Phase 1 configs
silently tested a no-op because of flag-polarity assumptions:

- `LOTL_MEMORY_SYNONYMS=on` — synonyms are ON by default (`!== "off"`).
  Setting `=on` was a no-op. Correct inverse test is `=off`.
- `LOTL_MEMORY_SCOPE_NORM=on` — code checks `=== "rank"`, not `=== "on"`.
  Setting `=on` was a no-op.
- `LOTL_MEMORY_EXPAND=keywords` — `keywords` is the default. Setting
  `=keywords` was a no-op (identical to baseline).

These are re-tested in Stage 14 of the follow-up chain with correct polarities.
The other 6 Phase 1 configs (mmr, expand-entities, lhash, diversify,
vec-min-sim-off, expand-keywords-as-baseline) were valid tests.

| tag | rAny@5 | R@5 | MRR | NDCG@10 | wall | verdict |
|---|---|---|---|---|---|---|
| **baseline** | **98.0%** | **93.6%** | **0.908** | **0.906** | 114 s | anchor |
| diversify | 98.0% | 93.5% (-0.1) | 0.907 (-0.001) | 0.904 | 79 s | neutral / kill candidate |
| expand-entities | 97.8% (-0.2) | 93.7% (+0.2) | 0.910 (+0.001) | 0.907 | 92 s | neutral / kill candidate |
| expand-keywords | 98.0% | 93.5% (-0.1) | 0.907 (-0.001) | 0.905 | 98 s | neutral / kill candidate |
| lhash | 98.0% | 93.5% (-0.1) | 0.907 (-0.001) | 0.905 | 80 s | neutral / kill candidate |
| mmr-session | 98.0% | 93.5% (-0.1) | 0.907 (-0.001) | 0.905 | 99 s | neutral / kill candidate |
| scope-norm | 98.0% | 93.5% (-0.1) | 0.907 (-0.001) | 0.905 | 79 s | neutral / kill candidate |
| synonyms | 98.0% | 93.7% (+0.1) | 0.907 (-0.001) | 0.905 | 84 s | neutral / kill candidate |
| vec-min-sim-off | 98.2% (+0.2) | 93.5% (-0.1) | 0.903 (-0.005) | 0.906 | 100 s | mixed, small MRR loss |

## Interpretation

**1. Ceiling effect on LME.** At 98% rAny@5 there's little headroom for any
flag to matter. The corpus doesn't discriminate between retrieval variants.

**2. Flags are candidates for Phase 4 deletion.** Seven of nine flags produce
−0.001 MRR with zero compensating upside on any metric. In a v1-cleanup
context these are maintenance-cost-only code paths.

**3. `vec-min-sim-off` is the only flag with asymmetric movement** (+0.2pp
rAny, −0.5pp MRR). Interpretation: removing the cosine floor admits more
low-similarity candidates, some of which contain the gold answer (rAny up),
but they rank lower on average (MRR down). The current default gate is
doing real work.

## Carry-over concern: baseline MRR drift

- SNAPSHOTS.md pinned value: **0.917** MRR (2026-04-18)
- Phase 1 baseline measurement: **0.908** MRR (same date, same DB)

**Drift: 0.9pp.** Something between the SNAPSHOTS pin and this sweep shifted
MRR. Not investigated yet. Possible causes:

- Code drift during the qmd→lotl rename (unlikely to touch ranking math)
- `--no-llm` code path differences (SNAPSHOTS no-LLM row vs our sweep)
- DB state drift (same file but possibly different FTS rebuild)

Action: after all sweeps complete, `git bisect` to find the commit that
shifted MRR. Or re-run the exact SNAPSHOTS reproducer and diff.

## Next steps (queued)

1. **Combined flag × BM25/vec weight sweep** (`flag-x-weight-sweep.txt`)
   — 19 configs at two additional weight ratios (7/3, 3/7). Tests whether
   any flag becomes a winner when vec gets more say.
2. **Phase 3 reranker A/B** — 6 candidates, all local ONNX via
   `TransformersRerankBackend`. ModernBERT support confirmed in
   transformers.js 4.1.0 registry.
3. **LoCoMo flag sweep** — same Phase 1 config on LoCoMo 10-conv corpus
   (R@5 ~67% baseline — much more headroom for flags to show signal).
4. **MRR drift investigation** — separate bisect task.

## Files

- Input: `evaluate/sweeps/configs/flag-sweep-phase1.txt`
- Output: `evaluate/sweeps/flag-sweep-phase1-20260418-232607/` (JSON per config, SUMMARY.md)
- Derived from: this file, after the combined sweep lands.
