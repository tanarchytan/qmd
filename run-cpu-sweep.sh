#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"

# ============================================================
# Phase 11.7 CPU sweep — all candidates in ascending-parameter order.
# Prefix auto-detection handled in src/llm/transformers-embed.ts (resolveEmbedPrefix).
# No code path per-model here — just env-var swaps.
# ============================================================

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

run() {
  local model="$1" tag="$2" params="$3"
  echo ""
  echo "==========================================================================="
  echo "=== START: $model  (${params}, tag=$tag, $(date +%H:%M:%S))"
  echo "==========================================================================="
  LOTL_TRANSFORMERS_EMBED="$model" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds s --limit 100 --no-llm --workers 2 \
      --tag "$tag" --db-suffix "$tag"
  local code=$?
  echo "=== END: $model (tag=$tag, $(date +%H:%M:%S), exit=$code)"
  return $code
}

# Ascending parameter order. Prefix families auto-detected by model id.
# Excluded models (transformers.js v4.1.0 arch incompat — silent crash on load):
#   - Alibaba-NLP/gte-base-en-v1.5   (model_type="new" not registered)
#   - nomic-ai/nomic-embed-text-v1.5 (custom bert variant not registered)
# Resuming from bge-large; e5-small/e5-base already done in earlier sweep.
run "Xenova/bge-large-en-v1.5"          "bge-large"      "335M"  || true
run "Xenova/UAE-Large-V1"               "uae-large"      "335M"  || true
run "Xenova/e5-large-v2"                "e5-large-v2"    "335M"  || true

echo ""
echo "==========================================================================="
echo "=== ALL DONE $(date +%H:%M:%S)"
echo "==========================================================================="
