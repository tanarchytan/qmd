#!/usr/bin/env bash
# Background watcher for the reranker sweep. Polls every INTERVAL seconds
# (default 60), detects when a new config completes, and prints a fresh
# diff table.
#
# Usage:
#   bash evaluate/scripts/watch-rerankers.sh                     # auto-detect latest
#   bash evaluate/scripts/watch-rerankers.sh <sweep-dir>         # explicit dir
#   bash evaluate/scripts/watch-rerankers.sh --interval 30       # poll every 30 s
#
# Run in background with: bash watch-rerankers.sh &
# Output goes to stdout — redirect with > /tmp/watch.log to tail later.
# Exits cleanly when all configs finish.

set -uo pipefail
cd "$(dirname "$0")/../.."

INTERVAL=60
DIR=""
NAME_FILTER="rerank-at-w73-locomo"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL=$2; shift 2 ;;
    --name) NAME_FILTER=$2; shift 2 ;;
    -*) echo "unknown arg: $1" >&2; exit 2 ;;
    *) DIR=$1; shift ;;
  esac
done

# Wait for sweep dir to appear if not given (handles being launched before sweep starts)
if [[ -z "$DIR" ]]; then
  echo "Waiting for sweep dir matching: evaluate/sweeps/${NAME_FILTER}-*/"
  while true; do
    DIR=$(ls -dt evaluate/sweeps/${NAME_FILTER}-*/ 2>/dev/null | head -1)
    if [[ -n "$DIR" ]]; then break; fi
    sleep "$INTERVAL"
  done
fi

DIR=${DIR%/}
echo "Watching: $DIR (interval=${INTERVAL}s)"
echo ""

TOTAL=$(awk '!/^#/ && NF>0 {count++} END {print count}' "$DIR/config.txt" 2>/dev/null)
LAST=0

while true; do
  completed=$(find "$DIR" -mindepth 2 -maxdepth 2 \( -name "lme.json" -o -name "locomo.json" \) 2>/dev/null | wc -l)
  if [[ "$completed" -gt "$LAST" ]]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo " [$(date +%H:%M:%S)] $completed / $TOTAL configs complete"
    echo "═══════════════════════════════════════════════════════════════════"
    node evaluate/scripts/summarize-sweep.mjs "$DIR"
    LAST=$completed
  fi
  # Exit when sweep finishes
  if [[ -f "$DIR/SUMMARY.md" && "$completed" -ge "$TOTAL" ]]; then
    echo ""
    echo "Sweep complete. Final summary written to $DIR/SUMMARY.md"
    break
  fi
  sleep "$INTERVAL"
done
