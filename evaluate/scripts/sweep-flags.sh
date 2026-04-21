#!/usr/bin/env bash
# Phase 1 flag-impact sweep runner.
#
# Reads a config file where each non-comment line has the form:
#   <tag> <env overlay space-separated KEY=VALUE>
# Example:
#   baseline
#   mmr                LOTL_MEMORY_MMR=session
#   expand-keywords    LOTL_MEMORY_EXPAND=keywords
#
# For each config, runs LME n=500 (and optionally LoCoMo) on the pre-populated
# mxbai-xs v17 DB. Writes all outputs under evaluate/sweeps/<sweep>/<tag>/.
#
# Usage:
#   bash evaluate/scripts/sweep-flags.sh <config-file> [--corpus lme|locomo|both] [--limit N] [--name NAME]
# Defaults: --corpus lme --limit 500 --name $(basename config .txt)

set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)

CONFIG_FILE=${1:?"usage: sweep-flags.sh <config-file> [--corpus ...] [--limit N] [--name NAME]"}
shift

CORPUS=lme
LIMIT=500
NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$NAME" ]] && NAME=$(basename "$CONFIG_FILE" .txt)

# Resume an incomplete sweep if one exists with the same --name prefix and
# no SUMMARY.md. Crash-restart friendly: watchdog re-invokes this script
# verbatim and we land back in the same dir, picking up where we left off.
EXISTING=$(ls -dt "$REPO/evaluate/sweeps/${NAME}-"*/ 2>/dev/null | head -1)
EXISTING=${EXISTING%/}
if [[ -n "$EXISTING" ]] && [[ -d "$EXISTING" ]] && [[ ! -f "$EXISTING/SUMMARY.md" ]]; then
  SWEEP_DIR="$EXISTING"
  echo "[sweep-flags] resuming incomplete sweep: $SWEEP_DIR"
else
  SWEEP_DIR="$REPO/evaluate/sweeps/${NAME}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$SWEEP_DIR"
  cp "$CONFIG_FILE" "$SWEEP_DIR/config.txt"
fi
echo "Sweep: $SWEEP_DIR"
echo "Corpus: $CORPUS, Limit: $LIMIT"

# Anchor: mxbai-xs winner, v17 pre-populated DB.
export LOTL_EMBED_BACKEND=transformers
export LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1
export LOTL_TRANSFORMERS_DTYPE=q8
export LOTL_EMBED_MAX_WORKERS=4
export LOTL_EMBED_MICROBATCH=32
export OMP_NUM_THREADS=4
# A/B hygiene: prevent access_count drift across configs sharing a DB
# (caught 2026-04-19 when LoCoMo Stage 3 baseline and baseline-w91 diverged
# by 4.5pp R@5 with identical config).
export LOTL_RECALL_NO_TOUCH=on

run_one_lme() {
  local tag=$1; local overlay=$2
  local outDir="$SWEEP_DIR/$tag"
  mkdir -p "$outDir"
  # Resumable: skip configs that already produced a non-partial lme.json.
  # Lets watchdog re-spawn after a crash without redoing completed configs.
  if [[ -f "$outDir/lme.json" ]] && node -e "const d=JSON.parse(require('fs').readFileSync('$outDir/lme.json')); process.exit(d.partial?1:0);" 2>/dev/null; then
    echo "=== [$tag] LME n=$LIMIT SKIP (already done)"
    return 0
  fi
  echo ""
  echo "=== [$tag] LME n=$LIMIT  overlay: ${overlay:-<none>} ==="
  local t0=$(date +%s)
  # `env -i` would wipe, so use env with overlay added to current.
  env $overlay npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit "$LIMIT" --workers 4 \
    --db-suffix mxbai-n500-v17 \
    --tag "sweep-$tag" \
    --no-llm 2>&1 | tee "$outDir/lme.log"
  local t1=$(date +%s); local elapsed=$((t1 - t0))
  if [[ -f "$REPO/evaluate/longmemeval/results-sweep-$tag.json" ]]; then
    cp "$REPO/evaluate/longmemeval/results-sweep-$tag.json" "$outDir/lme.json"
  else
    echo "WARN: no results JSON emitted for $tag" >&2
  fi
  echo "$elapsed" > "$outDir/lme.wall"
  echo "$overlay" > "$outDir/overlay"
  echo "--- $tag elapsed: ${elapsed}s"
}

run_one_locomo() {
  local tag=$1; local overlay=$2
  local outDir="$SWEEP_DIR/$tag"
  mkdir -p "$outDir"
  if [[ -f "$outDir/locomo.json" ]] && node -e "const d=JSON.parse(require('fs').readFileSync('$outDir/locomo.json')); process.exit(d.partial?1:0);" 2>/dev/null; then
    echo "=== [$tag] LoCoMo SKIP (already done)"
    return 0
  fi
  echo ""
  echo "=== [$tag] LoCoMo 10-conv  overlay: ${overlay:-<none>} ==="
  local t0=$(date +%s)
  env $overlay npx tsx evaluate/locomo/eval.mts \
    --workers 4 --tag "sweep-$tag" --no-llm 2>&1 | tee "$outDir/locomo.log"
  local t1=$(date +%s); local elapsed=$((t1 - t0))
  if [[ -f "$REPO/evaluate/locomo/results-sweep-$tag.json" ]]; then
    cp "$REPO/evaluate/locomo/results-sweep-$tag.json" "$outDir/locomo.json"
  fi
  echo "$elapsed" > "$outDir/locomo.wall"
  echo "--- $tag elapsed: ${elapsed}s"
}

# Parse config (skip # comments + blank lines)
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%%#*}                            # strip trailing comment
  line=$(echo "$line" | sed 's/[[:space:]]*$//')  # strip trailing ws
  [[ -z "${line// }" ]] && continue
  tag=$(echo "$line" | awk '{print $1}')
  overlay=$(echo "$line" | cut -d' ' -f2- | sed 's/^[[:space:]]*//')
  [[ "$overlay" == "$tag" ]] && overlay=""   # single-word line = baseline

  if [[ "$CORPUS" == "lme" || "$CORPUS" == "both" ]]; then
    run_one_lme "$tag" "$overlay"
  fi
  if [[ "$CORPUS" == "locomo" || "$CORPUS" == "both" ]]; then
    run_one_locomo "$tag" "$overlay"
  fi
done < "$CONFIG_FILE"

echo ""
echo "=== Sweep complete: $SWEEP_DIR ==="
echo ""
node evaluate/scripts/summarize-sweep.mjs "$SWEEP_DIR"
