#!/usr/bin/env bash
# Sequential QMD on LME _s — workers=1 to avoid ZeroEntropy BPM rate limits.
# Raw/fast mode only (the fastest config that still uses remote ZE).
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd
cp "$SRC/evaluate/longmemeval/eval.mts" ~/qmd-eval/evaluate/longmemeval/eval.mts
rm -rf ~/qmd-eval/evaluate/longmemeval/dbs

echo "=== QMD raw/fast stack on LME _s (n=50, workers=1, sequential) ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 50 --llm gemini \
  --answer-model gemini-2.5-flash \
  --tag lme-s-raw-seq-n50 2>&1 | tail -40 | tee /tmp/lme-s-raw-seq.log
