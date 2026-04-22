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

## Phase 0 — worker-bump smoke

Before any sweep, validate the 4-worker / ONNX-concurrent bump against the
2-worker baseline on n=50:

```sh
bash evaluate/scripts/smoke-worker-bump.sh
```

Passes if metrics are byte-identical within ε=1e-9. A failing parity check
points at a race condition and blocks every phase below.

## Phase 1 — flag-impact sweep (~40 min on LME n=500)

Each config ablates one retrieval flag vs baseline on the pre-populated
mxbai-xs v17 DB. Goal: split wired-but-untested flags into clear winners
vs losers vs neutrals.

```sh
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-phase1.txt \
  --corpus lme --limit 500
```

Config: `configs/flag-sweep-phase1.txt` (9 rows: baseline + 8 flag ablations,
KG omitted because populating it requires an LLM ingest pass — moved to Phase 5).

## Phase 2 — BM25/vec weight re-sweep

Once Phase 1 winners are known, append their overlays to each non-baseline
row in `configs/bm25-vec-sweep-phase2.txt` and run:

```sh
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/bm25-vec-sweep-phase2.txt \
  --corpus lme --limit 500
```

Env override wired in `src/store/constants.ts` — `LOTL_MEMORY_RRF_W_BM25` and
`LOTL_MEMORY_RRF_W_VEC` take precedence over the shipped defaults (0.9/0.1).

**Goal:** check if any Phase 1 winner shifts the optimal BM25 ratio below 0.7,
invalidating the current hardcoded default.

## Phase 3 — reranker A/B

Pre-flight first (validates each candidate loads + discriminates before the
full sweep burns hours):

```sh
npx tsx evaluate/scripts/probe-rerankers.mts
```

Fails-fast if ONNX unavailable / arch-incompat / no-signal on any candidate.
Drop failing rows from the config before running the sweep:

```sh
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus lme --limit 500
```

Config: 6 candidates (33M–184M params) + baseline. mxbai-base is the
already-shipped reference. ModernBERT pair (gte-reranker + tomaarsen) lands
in transformers.js 4.1.0 via the native `ModernBertForSequenceClassification`
class — no direct-ORT work needed.

**Kill-criterion:** if every reranker regresses, the RRF score normalization
fix becomes priority (see `src/store/constants.ts:67-74` KNOWN LIMITATION)
before more model A/Bs.

## Config file format

One config per line. First token is the tag, rest is space-separated
`KEY=VALUE` env overlay. Blank lines and `#` comments ignored.

```
# tag                 env overlay
baseline
mmr-session           LOTL_MEMORY_MMR=session
scope-norm            LOTL_MEMORY_SCOPE_NORM=on
combo-a               LOTL_MEMORY_SCOPE_NORM=on LOTL_MEMORY_EXPAND=entities
```

## Canonical DB

All Phase 1-3 sweeps use the pre-populated
`evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite` (1.7 GB, built once
with the v1 winner config). `--db-suffix mxbai-n500-v17` wires it up. No
per-config re-ingest.

Phase 5 (KG + fact-augmented keys) will need a fresh ingest pass — a
different DB suffix will anchor those runs.

## Convention: baseline first

Every config file should start with a `baseline` row. The summarizer uses
the first row as the delta anchor, so if the baseline drifts, everything
does.
