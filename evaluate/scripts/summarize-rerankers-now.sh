#!/usr/bin/env bash
# One-shot snapshot of rerank sweep state. Finds the latest rerank sweep
# directory and produces a reranker-specific diff table against the
# in-dir baseline row. Safe to re-run while the sweep is in flight.
#
# Usage:
#   bash evaluate/scripts/summarize-rerankers-now.sh                    # latest LoCoMo rerank × 7/3
#   bash evaluate/scripts/summarize-rerankers-now.sh --name phase3-lme  # specific named sweep
#   bash evaluate/scripts/summarize-rerankers-now.sh <sweep-dir>        # explicit directory

set -uo pipefail
cd "$(dirname "$0")/../.."

# Parse args
DIR=""
NAME_FILTER="rerank-at-w73-locomo"   # default: Stage 9
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME_FILTER=$2; shift 2 ;;
    -*) echo "unknown arg: $1" >&2; exit 2 ;;
    *) DIR=$1; shift ;;
  esac
done

if [[ -z "$DIR" ]]; then
  # Pick the most recently modified sweep matching the filter
  DIR=$(ls -dt evaluate/sweeps/${NAME_FILTER}-*/ 2>/dev/null | head -1)
  if [[ -z "$DIR" ]]; then
    echo "No sweep dir found matching: evaluate/sweeps/${NAME_FILTER}-*/" >&2
    exit 1
  fi
fi

DIR=${DIR%/}
echo "Sweep dir: $DIR"
echo "Timestamp: $(date +%H:%M:%S)"

# Count completed configs
completed=$(find "$DIR" -mindepth 2 -maxdepth 2 \( -name "lme.json" -o -name "locomo.json" \) 2>/dev/null | wc -l)
total=$(awk '!/^#/ && NF>0 {count++} END {print count}' "$DIR/config.txt" 2>/dev/null)
echo "Progress: $completed / $total configs complete"
echo ""

# Let summarize-sweep.mjs do the heavy lifting — it already builds the
# per-config diff table vs baseline and handles missing configs gracefully.
node evaluate/scripts/summarize-sweep.mjs "$DIR"
