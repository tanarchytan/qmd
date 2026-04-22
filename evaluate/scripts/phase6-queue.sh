#!/usr/bin/env bash
# Phase 6 queue — CPU-chained sweeps after today's #48/#49-51 finish.
#
# Waits for the currently-running LoCoMo weight sweep + big-rerankers to
# finish (polling their SUMMARY.md), then fires four LME sweeps in
# series so they don't thrash CPU against each other:
#
#   1) mmr-kpool-sweep-phase6        8 configs × ~14 min = ~2h
#   2) rerank-blend-sweep-phase6     5 configs × ~14 min = ~70 min
#   3) expand-synonyms-sweep-phase6  6 configs × ~14 min = ~85 min
#   4) max-chars-sweep-phase6        5 configs × ~14 min = ~70 min
#
# Total: ~5.5h after the current CPU clears. All on LME (faster judge
# signal + cleaner metrics than LoCoMo's 3h/config wall). LoCoMo
# follow-up fires only if a Phase 6 lever shows clear LME lift.
#
# No LM Studio required — all ONNX jina-tiny rerank + local embed.
#
# Usage:
#   bash evaluate/scripts/phase6-queue.sh                     # wait for current, then fire 3 in series
#   bash evaluate/scripts/phase6-queue.sh --skip-wait         # fire immediately (use only if CPU free)
#   bash evaluate/scripts/phase6-queue.sh --dry-run           # show plan, exit 0

set -uo pipefail
cd "$(dirname "$0")/../.."

MODE="queued"
for arg in "$@"; do
  case "$arg" in
    --skip-wait) MODE="immediate" ;;
    --dry-run)   MODE="dry-run" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

CONF_DIR="evaluate/sweeps/configs"
SWEEPS=(
  # Ordered by expected signal magnitude (biggest potential delta first so
  # we land the most informative results early if CPU budget gets cut).
  "max-chars-sweep-phase6.txt       lme    500   max-chars-phase6-lme"
  "mmr-kpool-sweep-phase6.txt       lme    500   mmr-kpool-phase6-lme"
  "rerank-blend-sweep-phase6.txt    lme    500   rerank-blend-phase6-lme"
  "expand-synonyms-sweep-phase6.txt lme    500   expand-syn-phase6-lme"
)

# Sweeps we wait for before firing Phase 6 (matches today's live sweep dirs).
BLOCKERS=(
  "evaluate/sweeps/rerank-weight-jina-locomo-20260420-091808/SUMMARY.md"
  "evaluate/sweeps/reranker-big-phase4-locomo-20260420-091829/SUMMARY.md"
)

echo "[phase6-queue] plan:"
for line in "${SWEEPS[@]}"; do
  echo "  • $line"
done
echo ""

if [[ "$MODE" == "dry-run" ]]; then
  echo "[phase6-queue] --dry-run: exiting without firing."
  exit 0
fi

if [[ "$MODE" == "queued" ]]; then
  echo "[phase6-queue] waiting for blockers (SUMMARY.md to appear):"
  for f in "${BLOCKERS[@]}"; do echo "    $f"; done
  while true; do
    all_ready=1
    for f in "${BLOCKERS[@]}"; do
      if [[ ! -f "$f" ]]; then all_ready=0; break; fi
    done
    if [[ "$all_ready" == "1" ]]; then
      echo "[phase6-queue] all blockers done — proceeding."
      break
    fi
    sleep 300   # 5 min poll; blockers take hours
  done
fi

for line in "${SWEEPS[@]}"; do
  read -r cfg corpus limit name <<<"$line"
  echo ""
  echo "=============================================================="
  echo "[phase6-queue] firing: $name (corpus=$corpus, limit=$limit, config=$cfg)"
  echo "=============================================================="
  bash evaluate/scripts/sweep-flags.sh "$CONF_DIR/$cfg" \
    --corpus "$corpus" --limit "$limit" --name "$name" \
    2>&1 | tail -50
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "[phase6-queue] sweep $name exited $rc — halting queue." >&2
    exit $rc
  fi
  echo "[phase6-queue] $name done."
done

echo ""
echo "[phase6-queue] all 3 sweeps complete. Review SUMMARY.md in each:"
for line in "${SWEEPS[@]}"; do
  read -r cfg corpus limit name <<<"$line"
  echo "  evaluate/sweeps/${name}-*/SUMMARY.md"
done
