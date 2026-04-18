#!/usr/bin/env bash
# Run LoCoMo conv-26 + conv-30 full (no API) against a supplied set of embedders.
# Invoked with env MODELS="tag1|model1|variant1|pool1 tag2|model2|variant2|pool2 ..."
# Variant/pool are used for direct-ORT models; leave empty for standard.
set -u
cd "$(dirname "$0")/../.."

export LOTL_EMBED_BACKEND=transformers
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

LOG_DIR="evaluate/locomo/conv26-30-logs"
mkdir -p "$LOG_DIR"

# Default model list = top-3 from n=500 LME sweep (2026-04-18):
#   baseline (mxbai-xs) — winner on rAny@5 + pref MRR
#   uae-large           — best MRR (0.921) + best NDCG@10
#   gte-small           — best value/size pick (30M params, 0.919 MRR)
# Override by exporting MODELS before running.
MODELS="${MODELS:-baseline|mixedbread-ai/mxbai-embed-xsmall-v1|| uae-large|Xenova/UAE-Large-V1|| gte-small|Xenova/gte-small||}"

for spec in $MODELS; do
  IFS='|' read -r tag model variant pool <<< "$spec"
  for conv in conv-26 conv-30; do
    logf="$LOG_DIR/${tag}_${conv}.log"
    echo ""
    echo "==========================================================================="
    echo "=== $tag · $conv · $(date +%H:%M:%S)"
    echo "==========================================================================="
    echo "log → $logf"

    rm -rf evaluate/locomo/dbs  # fresh ingest per model
    mkdir -p evaluate/locomo/dbs

    if [[ -n "$variant" ]]; then
      # direct-ORT backend
      unset LOTL_TRANSFORMERS_EMBED
      LOTL_EMBED_DIRECT=on \
      LOTL_TRANSFORMERS_MODEL="$model" \
      LOTL_TRANSFORMERS_DIRECT_VARIANT="$variant" \
      LOTL_TRANSFORMERS_DIRECT_POOLING="${pool:-last}" \
        npx tsx evaluate/locomo/eval.mts --conv "$conv" --no-llm 2>&1 | tee "$logf"
    else
      unset LOTL_EMBED_DIRECT LOTL_TRANSFORMERS_MODEL LOTL_TRANSFORMERS_DIRECT_VARIANT
      LOTL_TRANSFORMERS_EMBED="$model" \
        npx tsx evaluate/locomo/eval.mts --conv "$conv" --no-llm 2>&1 | tee "$logf"
    fi
    echo "=== DONE $tag · $conv · $(date +%H:%M:%S)"
  done
done

echo ""
echo "==========================================================================="
echo "=== ALL DONE $(date +%H:%M:%S)"
echo "==========================================================================="
