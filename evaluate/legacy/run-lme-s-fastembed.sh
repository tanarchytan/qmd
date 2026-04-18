#!/usr/bin/env bash
# QMD on LME _s using the new local fastembed backend — zero remote
# embedding calls, matches MemPalace's setup.
set -euo pipefail
source ~/.nvm/nvm.sh
cd ~/qmd-eval

SRC=/mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd

# Sync everything fastembed touches.
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

# Install fastembed into the eval project's node_modules.
cd ~/qmd-eval
if [ ! -d node_modules/fastembed ]; then
    echo "=== Installing fastembed in ~/qmd-eval ==="
    npm install fastembed 2>&1 | tail -5
fi

rm -rf evaluate/longmemeval/dbs

echo "=== QMD raw/fast + fastembed on LME _s (n=100) ==="
# QMD_EMBED_BACKEND=fastembed shortcircuits the remote path entirely.
# No QMD_EMBED_PROVIDER or API keys needed for embeddings.
# Rerank + queryExpansion still go via remote ZE if configured, but
# QMD_RECALL_RAW=on skips both — so this is truly no-remote-call.
QMD_EMBED_BACKEND=fastembed \
QMD_FASTEMBED_QUIET=on \
QMD_ZE_COLLECTIONS=off QMD_INGEST_REFLECTIONS=off QMD_PROMPT_RULES=v11.1 \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini \
  --workers 4 --answer-model gemini-2.5-flash \
  --tag lme-s-fastembed-n100 2>&1 | tail -50 | tee /tmp/lme-s-fastembed.log
