#!/usr/bin/env bash
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
cp "$SRC/src/memory/index.ts"      ~/qmd-eval/src/memory/index.ts
cp "$SRC/evaluate/locomo/eval.mts" ~/qmd-eval/evaluate/locomo/eval.mts

# Wipe cached DBs — metadata schema changed (new source_dialog_id field)
rm -rf ~/qmd-eval/evaluate/locomo/dbs

echo "=== LoCoMo v15.1 — MemPalace-aligned metric (DR@K + SR@K) ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --llm gemini \
  --tag locomo-v151-mempalace 2>&1 | tail -120
