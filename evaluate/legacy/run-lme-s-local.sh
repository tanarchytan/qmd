#!/usr/bin/env bash
# 100% local QMD benchmark on LongMemEval _s.
#   - fastembed (local ONNX) for embeddings
#   - --no-llm flag skips the Gemini answer pass
#   - QMD_RECALL_RAW=on skips LLM rerank + query expansion
#   - QMD_INGEST_EXTRACTION=off skips LLM extraction at ingest
# Zero network calls. Zero API cost. Reproducible.
#
# Defaults to full n=500 to match MemPalace's benchmark. Override via
# LIMIT=100 ./evaluate/run-lme-s-local.sh for a quick smoke test.
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
LIMIT=${LIMIT:-500}

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

rm -rf ~/qmd-eval/evaluate/longmemeval/dbs

echo "=== QMD 100% local on LME _s (n=$LIMIT, --no-llm, fastembed) ==="
QMD_EMBED_BACKEND=fastembed \
QMD_FASTEMBED_QUIET=on \
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit "$LIMIT" --no-llm \
  --workers 4 \
  --tag lme-s-local-n$LIMIT 2>&1 | tail -60 | tee /tmp/lme-s-local.log
