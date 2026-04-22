#!/usr/bin/env bash
# Run MemPalace's OWN benchmarks on the same datasets we use for QMD,
# so we have a real ground-truth baseline instead of relying on their
# published numbers plus our reimplementation of their metrics.
#
# Runs outside the git-tracked repo at ~/external/mempalace (cloned
# earlier). Uses the LoCoMo and LongMemEval files we already have.
#
# Runs sequentially because concurrent launches race on the first-run
# ONNX model download and corrupt the shared cache file.
set -euo pipefail

MP=~/external/mempalace
LOCOMO=~/qmd-eval/evaluate/locomo/locomo10.json
LME=~/qmd-eval/evaluate/longmemeval/longmemeval_oracle.json

mkdir -p ~/external/mempalace-results

echo "=== Dataset sanity ==="
[ -f "$LOCOMO" ] || { echo "missing $LOCOMO"; exit 1; }
[ -f "$LME"    ] || { echo "missing $LME"; exit 1; }
ls -la "$LOCOMO" "$LME"

echo
echo "=== MemPalace LoCoMo (conv-26 + conv-30, session granularity, raw) ==="
cd "$MP"
python3 benchmarks/locomo_bench.py "$LOCOMO" \
    --limit 2 \
    --mode raw \
    --granularity session \
    --top-k 50 \
    --out ~/external/mempalace-results/mp-locomo-session.json \
    2>&1 | tail -60

echo
echo "=== MemPalace LoCoMo (conv-26 + conv-30, dialog granularity, raw) ==="
python3 benchmarks/locomo_bench.py "$LOCOMO" \
    --limit 2 \
    --mode raw \
    --granularity dialog \
    --top-k 50 \
    --out ~/external/mempalace-results/mp-locomo-dialog.json \
    2>&1 | tail -60

echo
echo "=== MemPalace LME (oracle n=200, session granularity, raw) ==="
python3 benchmarks/longmemeval_bench.py "$LME" \
    --limit 200 \
    --mode raw \
    --granularity session \
    --out ~/external/mempalace-results/mp-lme-oracle200.jsonl \
    2>&1 | tail -60

echo
echo "=== Results saved to ~/external/mempalace-results/ ==="
ls -la ~/external/mempalace-results/
