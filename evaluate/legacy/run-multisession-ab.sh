#!/usr/bin/env bash
# Night 2026-04-14 multi-session A/B: 4 n=100 configs on mxbai-xs q8.
# Stage 1 establishes the baseline and isolates which lever moves the n=30
# multi-session bucket. Stage 2 (not in this script) re-runs the winner at n=500.
set -u
cd ~/qmd-eval
source ~/.nvm/nvm.sh

MODEL="mixedbread-ai/mxbai-embed-xsmall-v1"
DTYPE="q8"
LIMIT="${LIMIT:-100}"
LOG_DIR="/tmp/multisession-ab-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
echo "Logs → $LOG_DIR"

run_variant() {
  local tag="$1"; shift
  local extra_env=("$@")
  echo; echo "=== $tag @ n=$LIMIT ==="
  rm -rf evaluate/longmemeval/dbs
  env \
    QMD_EMBED_BACKEND=transformers \
    QMD_TRANSFORMERS_MODEL="$MODEL" \
    QMD_TRANSFORMERS_DTYPE="$DTYPE" \
    QMD_TRANSFORMERS_QUIET=on \
    QMD_ZE_COLLECTIONS=off \
    QMD_INGEST_REFLECTIONS=off \
    QMD_RECALL_RAW=on \
    QMD_INGEST_EXTRACTION=off \
    QMD_INGEST_SYNTHESIS=off \
    QMD_INGEST_PER_TURN=off \
    "${extra_env[@]}" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds s --limit "$LIMIT" --no-llm --workers 4 \
      --tag "$tag" > "$LOG_DIR/$tag.log" 2>&1
  local ec=$?
  if [ $ec -ne 0 ]; then
    echo "  FAIL (exit $ec) — see $LOG_DIR/$tag.log"
    return 0
  fi
  # Print the final summary lines.
  grep -E "R@5:|R@10:|MRR:|multi-session|Time:" "$LOG_DIR/$tag.log" | head -8
}

run_variant "ab-baseline-n$LIMIT"
run_variant "ab-expand-kw-n$LIMIT"   QMD_MEMORY_EXPAND=keywords
run_variant "ab-mmr-session-n$LIMIT" QMD_MEMORY_MMR=session
run_variant "ab-expand-mmr-n$LIMIT"  QMD_MEMORY_EXPAND=keywords QMD_MEMORY_MMR=session

echo
echo "=== SUMMARY ==="
for tag in ab-baseline-n$LIMIT ab-expand-kw-n$LIMIT ab-mmr-session-n$LIMIT ab-expand-mmr-n$LIMIT; do
  echo
  echo "--- $tag ---"
  grep -E "R@5:|multi-session|Time:" "$LOG_DIR/$tag.log" | head -6
done
echo
echo "Logs: $LOG_DIR"
