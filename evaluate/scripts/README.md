# evaluate/scripts/ — canonical eval runners + diagnostics

Current canonical scripts. One-off/historical scripts are archived:

- `devnotes/archive/jina-v5-probes/` — jina-v5 direct-ORT experiment
- `devnotes/archive/phase11-embedder-sweep/` — the concluded n=500 embedder sweep
- `evaluate/legacy/` — earlier one-off scripts from the fork-era

## Optimization sweep infrastructure (v1.x plan — Phase 0 onward)

### `smoke-worker-bump.sh`
Pre-flight for any sweep. Runs LME n=50 twice (baseline `workers=2` vs bumped
`workers=4` + `LOTL_EMBED_MAX_WORKERS=4` + `LOTL_EMBED_MICROBATCH=32` +
`OMP_NUM_THREADS=4`) and validates byte-identical metrics + reports speedup.

```sh
bash evaluate/scripts/smoke-worker-bump.sh
```

### `sweep-flags.sh`
General runner. Takes a config file listing `(tag, env overlay)` pairs and runs
LME n=500 (and optionally LoCoMo) for each. All configs use the pre-populated
mxbai-xs v17 DB, so there is no per-run ingest — only recall-flag differences.

```sh
# Phase 1 flag-impact sweep:
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-phase1.txt \
  --corpus lme --limit 500

# Same sweep on both corpora:
bash evaluate/scripts/sweep-flags.sh <config> --corpus both --limit 500
```

Outputs land in `evaluate/sweeps/<name>-<timestamp>/<tag>/` (one subfolder per
config). See `evaluate/sweeps/README.md` for the full layout convention.

### `summarize-sweep.mjs`
Reads all `<tag>/lme.json` and `<tag>/locomo.json` under a sweep directory and
prints a markdown diff table ranked against the `baseline` row. Invoked
automatically at the end of `sweep-flags.sh`. Writes `SUMMARY.md` next to the
configs.

```sh
node evaluate/scripts/summarize-sweep.mjs evaluate/sweeps/<sweep-dir>
```

### `compare-metrics.mjs`
Strict byte-identical metric parity check across two `results-*.json` files.
Used by `smoke-worker-bump.sh` to catch concurrency-introduced non-determinism.

```sh
node evaluate/scripts/compare-metrics.mjs a.json b.json   # exit 0 on match
```

## LoCoMo runners

### `sweep-locomo-full.sh`
Full 10-conversation LoCoMo run at the current default config. Writes
`evaluate/locomo/results-<tag>.json` + logs.

### `sweep-locomo-convs.sh`
Narrower runner for `conv-26` + `conv-30` across a supplied embedder list.
Override the model list via `MODELS=...` env.

## Diagnostics

### `inspect-lme-db.mjs`
Dump memory count, scope distribution, ingest stats for a LongMemEval SQLite
DB. Useful before re-running recall against a pre-populated DB.

```sh
node evaluate/scripts/inspect-lme-db.mjs evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite
```
