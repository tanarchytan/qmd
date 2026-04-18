# evaluate/sweeps/ — optimization sweep outputs

Each subdirectory is one sweep run, named `<tag>-<timestamp>/`. Produced by
`evaluate/scripts/sweep-flags.sh`.

## Layout per sweep

```
<tag>-<timestamp>/
├── config.txt           ← copy of the input config
├── SUMMARY.md           ← auto-generated markdown diff table (written by summarize-sweep.mjs)
├── baseline/
│   ├── lme.json         ← results JSON (config + summary metrics)
│   ├── lme.log          ← full stdout/stderr from the eval
│   ├── lme.wall         ← elapsed seconds (int)
│   ├── overlay          ← env overlay used (may be empty for baseline)
│   └── locomo.*         ← same shape if --corpus=both
├── <flag-A>/
│   └── ...
└── <flag-B>/
    └── ...
```

## Running a sweep

```sh
# Phase 0 smoke — validate worker bump first:
bash evaluate/scripts/smoke-worker-bump.sh

# Phase 1 flag-impact sweep (LME only, ~5-6 h):
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-phase1.txt \
  --corpus lme --limit 500

# Same sweep on LoCoMo too:
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-phase1.txt \
  --corpus both --limit 500
```

## Config file format

One config per line. First token is the tag, rest is space-separated
`KEY=VALUE` env overlay. Blank lines and `#` comments ignored.

```
# tag                 env overlay
baseline
mmr-session           LOTL_MEMORY_MMR=session
scope-norm            LOTL_MEMORY_SCOPE_NORM=on
```

## Canonical DB

All Phase 1-3 sweeps use the pre-populated `evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite`
(1.7 GB, built once with the v1 winner config). `--db-suffix mxbai-n500-v17`
wires it up. No per-config re-ingest.

## Convention: baseline first

Every config file should start with a `baseline` row (no overlay). The
summarizer uses the first row as the delta anchor, so if the baseline drifts,
everything does.
