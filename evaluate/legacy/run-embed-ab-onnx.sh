#!/usr/bin/env bash
# ONNX small-class embed A/B on LME _s via @huggingface/transformers backend.
# Baseline: MiniLM (fastembed). Candidates: 4 small-class ONNX models.
#
# Each run:
#   - unique dbs/ dir (different dim = fresh ingest)
#   - QMD_EMBED_BACKEND=transformers + QMD_TRANSFORMERS_MODEL=<repo>
#   - --no-llm, RAW recall, no LLM ingest = zero API cost
#
# LIMIT=100 default. Bump LIMIT=500 after picking winner.
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
LIMIT=${LIMIT:-100}

cp "$SRC/src/memory/index.ts"                 ~/qmd-eval/src/memory/index.ts
mkdir -p ~/qmd-eval/src/llm
cp "$SRC/src/llm/fastembed.ts"                ~/qmd-eval/src/llm/fastembed.ts
cp "$SRC/src/llm/transformers-embed.ts"       ~/qmd-eval/src/llm/transformers-embed.ts
cp "$SRC/src/llm/loader.ts"                   ~/qmd-eval/src/llm/loader.ts
cp "$SRC/src/llm/pull.ts"                     ~/qmd-eval/src/llm/pull.ts
cp "$SRC/src/llm/types.ts"                    ~/qmd-eval/src/llm/types.ts
cp "$SRC/src/llm/remote.ts"                   ~/qmd-eval/src/llm/remote.ts
cp "$SRC/src/llm/session.ts"                  ~/qmd-eval/src/llm/session.ts
cp "$SRC/src/llm/local.ts"                    ~/qmd-eval/src/llm/local.ts
cp "$SRC/src/llm.ts"                          ~/qmd-eval/src/llm.ts
cp "$SRC/evaluate/longmemeval/eval.mts"       ~/qmd-eval/evaluate/longmemeval/eval.mts

# Ensure @huggingface/transformers is installed in qmd-eval
if ! [ -d ~/qmd-eval/node_modules/@huggingface/transformers ]; then
    echo "Installing @huggingface/transformers in qmd-eval..."
    (cd ~/qmd-eval && npm install @huggingface/transformers 2>&1 | tail -5)
fi

run_fastembed() {
    local model="$1"; local tag="$2"
    echo; echo "=== $tag ($model)  LME _s n=$LIMIT ==="
    rm -rf ~/qmd-eval/evaluate/longmemeval/dbs
    QMD_EMBED_BACKEND=fastembed \
    QMD_FASTEMBED_MODEL="$model" \
    QMD_FASTEMBED_QUIET=on \
    QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off \
    QMD_RECALL_RAW=on \
    QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
      npx tsx evaluate/longmemeval/eval.mts --ds s --limit "$LIMIT" --no-llm \
      --workers 4 \
      --tag "$tag" 2>&1 | stdbuf -o0 tee "/tmp/$tag.log"
}

run_onnx() {
    local model="$1"; local dtype="$2"; local tag="$3"; local file="${4:-}"
    echo; echo "=== $tag ($model @ $dtype${file:+ file=$file})  LME _s n=$LIMIT ==="
    rm -rf ~/qmd-eval/evaluate/longmemeval/dbs
    QMD_EMBED_BACKEND=transformers \
    QMD_TRANSFORMERS_MODEL="$model" \
    QMD_TRANSFORMERS_DTYPE="$dtype" \
    QMD_TRANSFORMERS_FILE="$file" \
    QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off \
    QMD_RECALL_RAW=on \
    QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
      npx tsx evaluate/longmemeval/eval.mts --ds s --limit "$LIMIT" --no-llm \
      --workers 4 \
      --tag "$tag" 2>&1 | stdbuf -o0 tee "/tmp/$tag.log"
}

if [ "${SKIP_BASELINE:-0}" != "1" ]; then
    run_fastembed "AllMiniLML6V2" "lme-s-minilm-n$LIMIT"
fi

# Apples-to-apples: same MiniLM model through transformers.js backend
if [ "${SKIP_MINILM_TJS:-0}" != "1" ]; then
    run_onnx "sentence-transformers/all-MiniLM-L6-v2" "fp32" "lme-s-minilm-tjs-n$LIMIT"
fi

# Strongest candidates from toy probe, ordered smallest-to-biggest
# Nomic dropped: OOM 48GB batched matmul on 8K-context — CPU ORT incompatible
if [ "${SKIP_MXBAI:-0}" != "1" ]; then
    run_onnx "mixedbread-ai/mxbai-embed-xsmall-v1"      "fp32" "lme-s-mxbai-xs-n$LIMIT"
fi
if [ "${SKIP_GEMMA:-0}" != "1" ]; then
    run_onnx "onnx-community/embeddinggemma-300m-ONNX"  "q8"   "lme-s-gemma-onnx-n$LIMIT"
fi
if [ "${SKIP_JINA:-0}" != "1" ]; then
    run_onnx "jinaai/jina-embeddings-v5-text-nano-classification" "q8" "lme-s-jina-nano-n$LIMIT"
fi

# --- Round 2: quantized + L12 candidates ---
if [ "${RUN_L12_INT8:-1}" = "1" ]; then
    run_onnx "sentence-transformers/all-MiniLM-L12-v2" "fp32" "lme-s-minilm-l12-int8-n$LIMIT" "model_qint8_avx512_vnni"
fi
if [ "${RUN_L6_UINT8:-1}" = "1" ]; then
    run_onnx "sentence-transformers/all-MiniLM-L6-v2"  "fp32" "lme-s-minilm-l6-uint8-n$LIMIT" "model_quint8_avx2"
fi
if [ "${RUN_MXBAI_Q8:-1}" = "1" ]; then
    run_onnx "mixedbread-ai/mxbai-embed-xsmall-v1"     "q8"   "lme-s-mxbai-xs-q8-n$LIMIT"
fi

echo; echo "========= EMBED A/B (ONNX) SUMMARY ========="
for tag in \
    lme-s-minilm-n$LIMIT \
    lme-s-mxbai-xs-n$LIMIT \
    lme-s-gemma-onnx-n$LIMIT \
    lme-s-jina-nano-n$LIMIT; do
    echo; echo "=== $tag ==="
    grep -A 6 "Retrieval (primary" "/tmp/$tag.log" 2>/dev/null | head -8
done
