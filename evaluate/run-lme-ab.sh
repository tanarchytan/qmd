#!/usr/bin/env bash
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
cp "$SRC/src/memory/index.ts"           ~/qmd-eval/src/memory/index.ts
cp "$SRC/evaluate/longmemeval/eval.mts" ~/qmd-eval/evaluate/longmemeval/eval.mts
cp "$SRC/evaluate/locomo/eval.mts"      ~/qmd-eval/evaluate/locomo/eval.mts

rm -rf ~/qmd-eval/evaluate/longmemeval/dbs

echo "=== RUN A: v11 baseline (SR@K) ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11 \
  npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 50 --llm gemini \
  --workers 4 --extract-model gemini-2.5-flash-lite \
  --answer-model gemini-2.5-flash --tag lme-v15-srk 2>&1 | tail -60

echo
echo "=== RUN B: v11.1 fix ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
  npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 50 --llm gemini \
  --workers 4 --extract-model gemini-2.5-flash-lite \
  --answer-model gemini-2.5-flash --tag lme-v151-srk 2>&1 | tail -60
