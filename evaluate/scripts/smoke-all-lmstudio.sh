#!/usr/bin/env bash
# LM Studio end-to-end smoke on both benchmarks. Runs 4 pairs sequentially
# (LM Studio holds one model at a time on a single GPU):
#   1. LME v11          (default prompt, lenient judge)
#   2. LME v14 CoT      (audit-ported CoT, lenient judge)
#   3. LoCoMo v11       (default prompt, lenient judge)
#   4. LoCoMo v14 strict (CoT + strict judge)
#
# Parallelism (tuned for a 3090, 24 GB VRAM):
#   llama-3.1-8B weights 4.92 GB, kv-cache ~131 KB/token per slot
#   → parallel=16 @ ctx=8192  for v11 (short prompts + short outputs)
#   → parallel=12 @ ctx=10240 for v14 (CoT prompt ~6-8k + 2560 output)
#   qwen-35B weights 22.07 GB → solo @ parallel=1, ctx=16384
#
# Each pair runs load-gen / unload / load-judge / unload. llm-cache.json
# persists between runs so pass 2 replays pass 1 predictions via byte-identical
# cache hits (temp=0 + seed=42).
#
# Override per-run:
#   LOTL_LME_LIMIT=20  (LME questions)
#   LOTL_LOCOMO_LIMIT=5  (LoCoMo questions per conv × 10 convs = 50 total)
#   LOTL_LMSTUDIO_HOST=10.0.0.105:1234
#   LOTL_LMSTUDIO_GEN_MODEL / LOTL_LMSTUDIO_JUDGE_MODEL

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
GEN_MODEL="${LOTL_LMSTUDIO_GEN_MODEL:-meta-llama-3.1-8b-instruct}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on

# VRAM-tuned per prompt version. Override via env.
CTX_V11="${LOTL_LMSTUDIO_CTX_V11:-8192}"
PARALLEL_V11="${LOTL_LMSTUDIO_PARALLEL_V11:-16}"
# v14 CoT needs ~10k+ total (7-8k prompt + 2560 output). 16384 × 8 parallel
# = 22.1 GB VRAM, fits 24 GB with slack. Dropping parallel below 8 wastes VRAM.
CTX_V14="${LOTL_LMSTUDIO_CTX_V14:-16384}"
PARALLEL_V14="${LOTL_LMSTUDIO_PARALLEL_V14:-8}"
CTX_QWEN="${LOTL_LMSTUDIO_CTX_QWEN:-16384}"
PARALLEL_QWEN="${LOTL_LMSTUDIO_PARALLEL_QWEN:-1}"

LME_LIMIT="${LOTL_LME_LIMIT:-20}"
LOCOMO_LIMIT="${LOTL_LOCOMO_LIMIT:-5}"

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-lmstudio-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

# Unload every :N suffix variant so bare-name requests route deterministically.
# Leaving duplicates loaded causes transient "fetch failed" mid-run (caught
# d988cbd). Always start each load with a clean slate.
unload_all_instances() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}
load_llama() {
  local ctx="$1" parallel="$2"
  unload_all_instances "$GEN_MODEL"
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$GEN_MODEL\",\"context_length\":$ctx,\"parallel\":$parallel}" >&2
  echo "[loaded] $GEN_MODEL ctx=$ctx parallel=$parallel" >&2
}
load_qwen() {
  unload_all_instances "$JUDGE_MODEL"
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX_QWEN,\"parallel\":$PARALLEL_QWEN}" >&2
  echo "[loaded] $JUDGE_MODEL ctx=$CTX_QWEN parallel=$PARALLEL_QWEN" >&2
}

# Start clean — no leftover instances from prior runs.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

run_lme_pair() {
  local tag="$1" rules="$2"
  local ctx parallel
  if [ "$rules" = "v14" ]; then ctx=$CTX_V14; parallel=$PARALLEL_V14; else ctx=$CTX_V11; parallel=$PARALLEL_V11; fi
  echo ""
  echo "################ PAIR: lme $tag (rules=$rules, ctx=$ctx, parallel=$parallel) ################"

  load_llama "$ctx" "$parallel"
  LOTL_PROMPT_RULES="$rules" LOTL_LME_WORKERS="$parallel" LOTL_LMSTUDIO_CTX="$ctx" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/lme-$tag-gen.log"

  load_qwen
  LOTL_PROMPT_RULES="$rules" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "smoke-$tag-pass2" 2>&1 | tee "$LOG_DIR/lme-$tag-judge.log"
}

run_locomo_pair() {
  local tag="$1" rules="$2" judge="$3"
  local ctx parallel
  if [ "$rules" = "v14" ]; then ctx=$CTX_V14; parallel=$PARALLEL_V14; else ctx=$CTX_V11; parallel=$PARALLEL_V11; fi
  echo ""
  echo "################ PAIR: locomo $tag (rules=$rules, judge=$judge, ctx=$ctx, parallel=$parallel) ################"

  load_llama "$ctx" "$parallel"
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_WORKERS="$parallel" LOTL_LMSTUDIO_CTX="$ctx" \
    npx tsx evaluate/locomo/eval.mts \
      --limit "$LOCOMO_LIMIT" --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/locomo-$tag-gen.log"

  load_qwen
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_JUDGE="$judge" LOTL_LOCOMO_WORKERS="$PARALLEL_QWEN" \
    npx tsx evaluate/locomo/eval.mts \
      --limit "$LOCOMO_LIMIT" --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "smoke-$tag-pass2" 2>&1 | tee "$LOG_DIR/locomo-$tag-judge.log"
}

# 4 smoke configurations.
run_lme_pair    v11          v11
run_lme_pair    v14-cot      v14
run_locomo_pair v11-lenient  v11  lenient
run_locomo_pair v14-strict   v14  strict

# Final cleanup.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

echo ""
echo "===== ALL 4 SMOKE PAIRS DONE ($(date)) ====="
echo "Logs: $LOG_DIR"
ls -la evaluate/longmemeval/results-smoke-*.json 2>/dev/null
ls -la evaluate/locomo/results-smoke-*.json 2>/dev/null
