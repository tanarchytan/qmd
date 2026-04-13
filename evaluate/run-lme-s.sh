#!/usr/bin/env bash
# Run QMD + MemPalace on longmemeval_s_cleaned for apples-to-apples with
# MemPalace's published 96.6% headline (which is on _s, not oracle).
#
# Runs two QMD configs in parallel:
#   A. v15.1 default stack (token-overlap R@K — our current headline)
#   B. raw/fast stack (QMD_RECALL_RAW + extraction off + synthesis off +
#      per-turn off, closest QMD can get to MemPalace's pure-vector recipe
#      without a local embedding backend swap)
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd

cp "$SRC/src/memory/index.ts"                 ~/qmd-eval/src/memory/index.ts
cp "$SRC/src/memory/decay.ts"                 ~/qmd-eval/src/memory/decay.ts
cp "$SRC/src/memory/extractor.ts"             ~/qmd-eval/src/memory/extractor.ts
cp "$SRC/src/llm.ts"                          ~/qmd-eval/src/llm.ts
mkdir -p ~/qmd-eval/src/llm
cp "$SRC/src/llm/loader.ts"                   ~/qmd-eval/src/llm/loader.ts
cp "$SRC/src/llm/pull.ts"                     ~/qmd-eval/src/llm/pull.ts
cp "$SRC/src/llm/types.ts"                    ~/qmd-eval/src/llm/types.ts
cp "$SRC/src/llm/remote.ts"                   ~/qmd-eval/src/llm/remote.ts
cp "$SRC/src/llm/session.ts"                  ~/qmd-eval/src/llm/session.ts
cp "$SRC/src/llm/local.ts"                    ~/qmd-eval/src/llm/local.ts
cp "$SRC/evaluate/longmemeval/eval.mts"       ~/qmd-eval/evaluate/longmemeval/eval.mts
cp "$SRC/evaluate/locomo/eval.mts"            ~/qmd-eval/evaluate/locomo/eval.mts

# Fresh db dir — _s has a different schema than oracle.
rm -rf ~/qmd-eval/evaluate/longmemeval/dbs

echo "=== QMD v15.1 default stack on LME _s (n=100 first) ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini \
  --workers 4 --answer-model gemini-2.5-flash \
  --tag lme-s-v151-n100 > /tmp/lme-s-v151.log 2>&1 &
PA=$!

echo "=== QMD raw/fast stack on LME _s (n=100) ==="
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini \
  --workers 4 --answer-model gemini-2.5-flash \
  --tag lme-s-raw-n100 > /tmp/lme-s-raw.log 2>&1 &
PB=$!

wait $PA || echo "QMD v15.1 exited non-zero"
wait $PB || echo "QMD raw exited non-zero"

echo
echo "=== QMD v15.1 tail ==="
tail -35 /tmp/lme-s-v151.log

echo
echo "=== QMD raw tail ==="
tail -35 /tmp/lme-s-raw.log
