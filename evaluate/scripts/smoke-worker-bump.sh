#!/usr/bin/env bash
# Phase 0 smoke: validate the 4-worker bump against the 2-worker baseline.
#
# Runs LME n=50 twice on the pre-populated mxbai-xs DB (lme-s-mxbai-n500-v17.sqlite):
#   A) baseline: --workers 2
#   B) bumped:   --workers 4 + LOTL_EMBED_MAX_WORKERS=4 + LOTL_EMBED_MICROBATCH=32 + OMP_NUM_THREADS=4
#
# Compares wall-time and metric parity. Metrics MUST be byte-identical (pure
# recall, deterministic seeds) — if they drift, there's a race condition.
#
# Usage: bash evaluate/scripts/smoke-worker-bump.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

REPO=$(pwd)
RESULTS_DIR="$REPO/evaluate/longmemeval"
SWEEP_DIR="$REPO/evaluate/sweeps/smoke-worker-bump-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SWEEP_DIR"

# Common env (anchors the DB, uses the pre-populated v17 index)
export LOTL_EMBED_BACKEND=transformers
export LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1
export LOTL_TRANSFORMERS_DTYPE=q8

run_cfg() {
  local tag=$1; shift
  local workers=$1; shift
  echo ""
  echo "=== $tag (workers=$workers) ==="
  local t0=$(date +%s)
  "$@" npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 50 --workers "$workers" \
    --db-suffix mxbai-n500-v17 \
    --tag "smoke-$tag" \
    --no-llm
  local t1=$(date +%s)
  local elapsed=$((t1 - t0))
  echo "--- $tag elapsed: ${elapsed}s"
  cp "$RESULTS_DIR/results-smoke-$tag.json" "$SWEEP_DIR/$tag.json"
  echo "$elapsed" > "$SWEEP_DIR/$tag.wall"
}

# A: baseline
run_cfg "a-baseline-w2" 2 env

# B: bumped
run_cfg "b-bumped-w4" 4 env \
  LOTL_EMBED_MAX_WORKERS=4 \
  LOTL_EMBED_MICROBATCH=32 \
  OMP_NUM_THREADS=4

echo ""
echo "=== Metric parity check ==="
node "$REPO/evaluate/scripts/compare-metrics.mjs" \
  "$SWEEP_DIR/a-baseline-w2.json" \
  "$SWEEP_DIR/b-bumped-w4.json"

echo ""
echo "=== Wall-time ==="
A=$(cat "$SWEEP_DIR/a-baseline-w2.wall")
B=$(cat "$SWEEP_DIR/b-bumped-w4.wall")
echo "  baseline w=2: ${A}s"
echo "  bumped   w=4: ${B}s"
if [[ "$B" -gt 0 ]]; then
  PCT=$(awk -v a="$A" -v b="$B" 'BEGIN{printf "%.1f", (a-b)/a*100}')
  echo "  speedup: ${PCT}%"
fi

echo ""
echo "Smoke results: $SWEEP_DIR"
