# evaluate/legacy/ — archived eval scripts

Scripts in this directory are **archived**. They were one-off ablation runners or
diagnostic tools that are no longer part of the canonical eval pipeline.

Kept for reference only — do NOT rely on them for current runs. Canonical
scripts live in `../scripts/`.

## Canonical replacements (in `../scripts/`)

| Legacy | Current replacement | Purpose |
|---|---|---|
| `run-lme-s.sh`, `run-lme-s-*.sh`, `run-lme-ab.sh`, `run-embed-ab*.sh`, `run-multisession-ab.sh` | `sweep-n500-embedders.sh` | Sweep N embedders against LongMemEval _s at n=500 |
| `run-locomo-mempalace.sh`, `run-mempalace-baseline.sh` | `sweep-locomo-convs.sh` | Run LoCoMo convs against a set of embedders |
| `audit-baselines.sh`, `compare-ab.sh` | — | Ad-hoc summarization; subsumed by results JSON directly |
| `batch-sr5-report.py`, `report-result.py`, `report-sr5.py`, `summarize*.py` | — | Ad-hoc reporting; use `results-*.json` + `jq` |
| `preference-misses.py`, `preference-rank-diagnostic.mts`, `mempalace-per-cat.py` | — | One-off debugging scripts |
| `sanity-transformers2.mjs` | `../scripts/probe-jina-v5.mts` | Generic sanity probe pattern |
| `recommend-workers.mjs` | — | Superseded by `src/llm/embed-sizer.ts` (automatic sizing) |

If you find yourself re-creating one of these, first check whether the canonical
scripts + `evaluate/locomo/eval.mts` + `evaluate/longmemeval/eval.mts` flags
cover the use case. Most were one-offs that are now either unnecessary (covered
by the main eval harness) or superseded by automated tooling.
