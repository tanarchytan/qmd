#!/usr/bin/env bash
# Phase D #53-bis — decoder-only BEIR rerank sweep with high parallel slots.
#
# After the first BEIR attempt revealed cross-encoder rerankers can't ride
# the /v1/chat/completions shim ("context does not logits computation"),
# restrict to DECODER-style rerankers that emit a score token in chat:
#
#   qwen3-reranker-0.6b    (~640 MB)  — parallel=32
#   qwen3-reranker-4b      (~2.6 GB)  — parallel=16
#   mxbai-rerank-base-v2   (~531 MB)  — parallel=32
#   mxbai-rerank-large-v2  (~1.6 GB)  — parallel=16
#
# Per-model: unload previous, load current with parallel=N, fire sweep-flags
# with WORKERS=N, unload, next. 24 GB VRAM fits all four comfortably once
# the prior load is unloaded.
#
# Prerequisites:
#   - LM Studio running at LOTL_LMSTUDIO_HOST (default 10.0.0.113:1234)
#   - All 4 GGUF models downloaded (done 2026-04-20)
#   - lmstudio-rerank.ts patched with reasoning_content fallback (commit TBD)

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.113:1234}"
CTX=4096        # per-slot ctx — short rerank prompts don't need more

# Model → parallel-slot assignments
declare -A PARALLEL
PARALLEL[qwen3-reranker-0.6b]=32
PARALLEL[qwen3-reranker-4b]=16
PARALLEL[mxbai-rerank-base-v2]=32
PARALLEL[mxbai-rerank-large-v2]=16

# Sweep name → tag for one-off sweep-flags invocation per model
SWEEP_BASE="beir-decoder-parallel"

unload_all() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}

unload_everything() {
  # Purge any lingering LLMs/rerankers from prior runs
  for m in google/gemma-4-26b-a4b google/gemma-4-e4b meta-llama-3.1-8b-instruct qwen/qwen3.6-35b-a3b \
           qwen3-reranker-0.6b qwen3-reranker-4b mxbai-rerank-base-v2 mxbai-rerank-large-v2 \
           jina-reranker-v1-tiny-en jina-reranker-v3 gte-reranker-modernbert-base \
           text-embedding-bge-reranker-v2-m3; do
    unload_all "$m"
  done
}

load_rerank_parallel() {
  local model="$1"; local parallel="$2"
  local total_ctx=$((CTX * parallel))
  echo "[beir-parallel] loading $model  ctx_total=$total_ctx parallel=$parallel"
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"context_length\":$total_ctx,\"parallel\":$parallel}" >/dev/null
}

# One throwaway config file per model so sweep-flags only runs the one config
write_single_config() {
  local model="$1"; local cfg_file="$2"
  cat >"$cfg_file" <<EOF
${model}    LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_RERANK=on LOTL_RERANK_BACKEND=lmstudio LOTL_LMSTUDIO_RERANK_MODEL=${model}
EOF
}

echo "=== phase-d-beir-decoder-parallel ==="
unload_everything
sleep 3

TMPDIR=$(mktemp -d)
# Skip qwen3-reranker-* — thinking models; enable_thinking:false isn't honored
# by LM Studio and each rerank call takes ~47s of reasoning (caught 2026-04-21
# on qwen3-reranker-0.6b at parallel=32 — 2.5 h per config, unusable).
# Only mxbai-rerank-v2 family confirmed to rerank quickly as non-thinking decoders.
for model in mxbai-rerank-base-v2 mxbai-rerank-large-v2; do
  parallel="${PARALLEL[$model]}"
  cfg_file="$TMPDIR/${model}.txt"
  write_single_config "$model" "$cfg_file"
  echo ""
  echo "=============================================="
  echo "[beir-parallel] config: $model (parallel=$parallel)"
  echo "=============================================="

  unload_everything
  sleep 2
  if ! load_rerank_parallel "$model" "$parallel"; then
    echo "[beir-parallel] $model failed to load — skipping" >&2
    continue
  fi
  sleep 2

  # Match client-side worker pool to server-side parallel slots
  LOTL_LMSTUDIO_RERANK_WORKERS="$parallel" \
    bash evaluate/scripts/sweep-flags.sh "$cfg_file" \
      --corpus locomo --name "${SWEEP_BASE}-${model}"
done

unload_everything
rm -rf "$TMPDIR"

echo ""
echo "=== phase-d-beir-decoder-parallel DONE ==="
echo "Summaries:"
for d in evaluate/sweeps/${SWEEP_BASE}-*/SUMMARY.md; do
  [[ -f "$d" ]] && echo "  $d"
done
