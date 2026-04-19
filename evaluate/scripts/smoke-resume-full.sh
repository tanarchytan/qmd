#!/usr/bin/env bash
# Full resume script — kills the current smoke, retries LME v14 CoT pair 2
# (with cache hits for already-succeeded questions, fresh gen for failed +
# pending) at parallel=12, then runs LoCoMo pairs 3+4 with parallel sized
# per prompt version. Qwen judge always at parallel=1 (already saturated).
#
# Why this vs the original smoke: serial LME v14 CoT takes ~3.25 min/q on
# llama @ parallel=1 — the 3090 is only 7% utilized because each request
# owns the GPU for its whole generation. With parallel=12 + LOTL_LME_WORKERS=12,
# 12 questions batch through the same forward pass → ~10x throughput.

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

# VRAM budget on 3090 (24 GB):
#   llama-3.1-8B weights: 4.92 GB; kv-cache: 131 KB/token per slot
#   → parallel=12 @ ctx=10240 fits v14 CoT (~8k prompt + 2560 output) with headroom
#   → parallel=16 @ ctx=8192 fits v11 (shorter)
#   qwen-35B weights: 22.07 GB; solo @ parallel=1 only
# IMPORTANT: LM Studio's `context_length` is TOTAL ctx shared across parallel
# slots, NOT per-slot. Per-slot ctx = context_length / parallel. Verified
# empirically: parallel=8 ctx=16384 → 2048 per slot → context-exceeded on
# every v14 CoT prompt. Math below sizes context_length = desired_per_slot × parallel.
CTX_V11=65536     # 4096 per slot × 16 slots — v11 prompts stay under 4k
PARALLEL_V11=16
CTX_V14=98304     # 12288 per slot × 8 slots — v14 CoT needs ~10k (8k prompt + 2560 output)
PARALLEL_V14=8
CTX_QWEN=16384
PARALLEL_QWEN=1

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-resume-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

# Unload every :N suffix variant — leaves single clean instance after load.
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

# Start clean — both models unloaded.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

#################################
# PAIR 2 — LME v14 CoT (retry)  #
#################################
# llm-cache.json holds byte-identical predictions from the 14 successful
# questions of the original run. Re-running with the same seed + temp=0
# yields cache hits for those; the 2 failed + 6 pending questions generate
# fresh with llama @ parallel=12. Total ~3-4 min vs the ~60 min it would
# take to finish on serial.
echo ""
echo "################ PAIR: LME v14-cot (retry+finish, parallel=$PARALLEL_V14, workers=$PARALLEL_V14) ################"
load_llama "$CTX_V14" "$PARALLEL_V14"
LOTL_PROMPT_RULES=v14 LOTL_LME_WORKERS="$PARALLEL_V14" LOTL_LMSTUDIO_CTX="$CTX_V14" \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit 20 --llm lmstudio \
    --tag "smoke-v14-cot-pass1-retry" 2>&1 | tee "$LOG_DIR/lme-v14-cot-gen.log"

load_qwen
LOTL_PROMPT_RULES=v14 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit 20 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v14-cot-pass2" 2>&1 | tee "$LOG_DIR/lme-v14-cot-judge.log"

##############################################
# PAIR 3 — LoCoMo v11 lenient (5 Q × 10 conv) #
##############################################
echo ""
echo "################ PAIR: LoCoMo v11-lenient (parallel=$PARALLEL_V11, workers=$PARALLEL_V11) ################"
load_llama "$CTX_V11" "$PARALLEL_V11"
LOTL_PROMPT_RULES=v11 LOTL_LOCOMO_WORKERS="$PARALLEL_V11" LOTL_LMSTUDIO_CTX="$CTX_V11" \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --tag "smoke-v11-lenient-pass1" 2>&1 | tee "$LOG_DIR/locomo-v11-lenient-gen.log"

load_qwen
LOTL_PROMPT_RULES=v11 LOTL_LOCOMO_JUDGE=lenient LOTL_LOCOMO_WORKERS="$PARALLEL_QWEN" \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v11-lenient-pass2" 2>&1 | tee "$LOG_DIR/locomo-v11-lenient-judge.log"

#############################################
# PAIR 4 — LoCoMo v14 CoT strict             #
#############################################
echo ""
echo "################ PAIR: LoCoMo v14-strict (parallel=$PARALLEL_V14, workers=$PARALLEL_V14) ################"
load_llama "$CTX_V14" "$PARALLEL_V14"
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_WORKERS="$PARALLEL_V14" LOTL_LMSTUDIO_CTX="$CTX_V14" \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --tag "smoke-v14-strict-pass1" 2>&1 | tee "$LOG_DIR/locomo-v14-strict-gen.log"

load_qwen
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_JUDGE=strict LOTL_LOCOMO_WORKERS="$PARALLEL_QWEN" \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v14-strict-pass2" 2>&1 | tee "$LOG_DIR/locomo-v14-strict-judge.log"

# Final cleanup — unload everything.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

echo ""
echo "===== RESUME FULL SMOKE DONE ($(date)) ====="
echo "LME results:"
ls -la evaluate/longmemeval/results-smoke-v14-cot-pass{1-retry,2}.json 2>/dev/null
echo "LoCoMo results:"
ls -la evaluate/locomo/results-smoke-*.json 2>/dev/null
