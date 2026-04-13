#!/usr/bin/env bash
# Embed-model A/B on LME _s n=100 (100% local, --no-llm, free).
# Four stock fastembed models run sequentially (each loads its own ONNX
# session so parallel would just thrash).
#
# LIMIT=100 by default. Bump with LIMIT=500 ./evaluate/run-embed-ab.sh
# for the full run once a winner is clear.
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
LIMIT=${LIMIT:-100}

cp "$SRC/src/memory/index.ts"                 ~/qmd-eval/src/memory/index.ts
mkdir -p ~/qmd-eval/src/llm
cp "$SRC/src/llm/fastembed.ts"                ~/qmd-eval/src/llm/fastembed.ts
cp "$SRC/src/llm/loader.ts"                   ~/qmd-eval/src/llm/loader.ts
cp "$SRC/src/llm/pull.ts"                     ~/qmd-eval/src/llm/pull.ts
cp "$SRC/src/llm/types.ts"                    ~/qmd-eval/src/llm/types.ts
cp "$SRC/src/llm/remote.ts"                   ~/qmd-eval/src/llm/remote.ts
cp "$SRC/src/llm/session.ts"                  ~/qmd-eval/src/llm/session.ts
cp "$SRC/src/llm/local.ts"                    ~/qmd-eval/src/llm/local.ts
cp "$SRC/src/llm.ts"                          ~/qmd-eval/src/llm.ts
cp "$SRC/evaluate/longmemeval/eval.mts"       ~/qmd-eval/evaluate/longmemeval/eval.mts

run_model() {
    local model="$1"
    local tag="$2"
    echo
    echo "=============================================================="
    echo "  $tag ($model)  — LME _s n=$LIMIT"
    echo "=============================================================="
    # Different model = different ingested vector dim = needs a fresh dbs dir.
    rm -rf ~/qmd-eval/evaluate/longmemeval/dbs
    QMD_EMBED_BACKEND=fastembed \
    QMD_FASTEMBED_MODEL="$model" \
    QMD_FASTEMBED_QUIET=on \
    QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off \
    QMD_RECALL_RAW=on \
    QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
      npx tsx evaluate/longmemeval/eval.mts --ds s --limit "$LIMIT" --no-llm \
      --workers 4 \
      --tag "$tag" 2>&1 | tail -25 | tee "/tmp/$tag.log"
}

run_model "AllMiniLML6V2"  "lme-s-minilm-n$LIMIT"
run_model "BGESmallENV15"  "lme-s-bge-small-n$LIMIT"
run_model "BGEBaseENV15"   "lme-s-bge-base-n$LIMIT"
# MLE5Large is 2.2GB and much slower — only run if the smaller ones
# show real quality variance worth chasing.
# run_model "MLE5Large"    "lme-s-mle5-n$LIMIT"

echo
echo "=============================================================="
echo "  EMBED A/B COMPLETE — summary"
echo "=============================================================="
for tag in lme-s-minilm-n$LIMIT lme-s-bge-small-n$LIMIT lme-s-bge-base-n$LIMIT; do
    echo
    echo "=== $tag ==="
    grep -A 6 "Retrieval (primary" "/tmp/$tag.log" 2>/dev/null | head -8
done
