#!/usr/bin/env bash
# Full n=500 run of QMD with fastembed on LME _s — head-to-head with
# MemPalace's published 96.6%.
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd

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

echo "=== QMD + fastembed on LME _s (full n=500, no answer model to match MP) ==="
QMD_EMBED_BACKEND=fastembed \
QMD_FASTEMBED_QUIET=on \
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --llm gemini \
  --workers 4 --answer-model gemini-2.5-flash \
  --tag lme-s-fastembed-n500 2>&1 | tail -60 | tee /tmp/lme-s-fe-500.log
