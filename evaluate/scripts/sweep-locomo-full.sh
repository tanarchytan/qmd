#!/usr/bin/env bash
# Run full LoCoMo (all 10 convs) against the winner (mxbai-xs baseline).
# Local only, no API.
set -u
cd "$(dirname "$0")/../.."

export LOTL_EMBED_BACKEND=transformers
export LOTL_EMBED_MODEL="mixedbread-ai/mxbai-embed-xsmall-v1"
export LOTL_TRANSFORMERS_DTYPE=q8
export LOTL_TRANSFORMERS_DEVICE=cpu
export LOTL_VEC_MIN_SIM=0.1
export LOTL_RECALL_RAW=on
export LOTL_INGEST_EXTRACTION=off
export LOTL_INGEST_REFLECTIONS=off
export LOTL_INGEST_SYNTHESIS=off
export LOTL_INGEST_PER_TURN=off
export LOTL_EMBED_MICROBATCH=32
export LOTL_TRANSFORMERS_QUIET=on
unset LOTL_EMBED_DIRECT LOTL_TRANSFORMERS_MODEL LOTL_TRANSFORMERS_DIRECT_VARIANT

LOG_DIR="evaluate/locomo/full-logs"
mkdir -p "$LOG_DIR"

# Fresh DB per run so we get a clean apples-to-apples comparison.
# Uses --db-suffix baseline-full so Step 11 (Poe judge) can reuse.
rm -rf evaluate/locomo/dbs
mkdir -p evaluate/locomo/dbs

LOG="$LOG_DIR/baseline-full.log"
echo "==========================================================================="
echo "=== START: mxbai-xs baseline — ALL 10 LOCOMO CONVS ($(date +%H:%M:%S))"
echo "==========================================================================="
echo "log → $LOG"

npx tsx evaluate/locomo/eval.mts \
  --no-llm \
  --tag baseline-full \
  --db-suffix baseline-full 2>&1 | tee "$LOG"

echo "=== END: baseline-full ($(date +%H:%M:%S))"
