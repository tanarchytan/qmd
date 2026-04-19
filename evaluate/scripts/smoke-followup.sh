#!/usr/bin/env bash
# Post-smoke follow-up: (A) rejudge pair 4 dropped verdicts with qwen@32k,
# (B) gemma-4 A/B run, (C) fill the 2×2 LoCoMo ablation (v11-strict +
# v14-lenient). Runs sequentially on the LM Studio host.
#
# Each step writes its own result tags so they don't collide with the
# original smoke numbers.

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
# Steps A + C need llama gen cache + qwen judge. Step B spawns smoke-gemma-validate.sh
# which expects LOTL_LMSTUDIO_GEN_MODEL / LOTL_LMSTUDIO_JUDGE_MODEL to be UNSET so
# its gemma defaults win. So we keep GEN_MODEL / JUDGE_MODEL as local vars here,
# NOT exported — the nested gemma script reads its own defaults.
GEN_MODEL="${LOTL_LMSTUDIO_GEN_MODEL:-meta-llama-3.1-8b-instruct}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}"
export LOTL_LMSTUDIO_HOST="$HOST"
# Deliberately NOT exporting LOTL_LMSTUDIO_GEN_MODEL / JUDGE_MODEL (see above).
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on
export LOTL_RECALL_NO_TOUCH=on  # load-bearing for cache-replay across pass1/pass2

# qwen at 32k: fits long v14 CoT predictions in the judge input without overflow.
CTX_QWEN=32768
PARALLEL_QWEN=1

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-followup-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

unload_all_instances() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}
load_qwen() {
  unload_all_instances "$GEN_MODEL"
  unload_all_instances "google/gemma-4-e4b"
  unload_all_instances "google/gemma-4-26b-a4b"
  unload_all_instances "$JUDGE_MODEL"
  # 3s VRAM-release settle before loading qwen (~22 GB).
  sleep 3
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX_QWEN,\"parallel\":$PARALLEL_QWEN}" >&2
  echo "[loaded] $JUDGE_MODEL ctx=$CTX_QWEN parallel=$PARALLEL_QWEN" >&2
}

###################################
# A — Rejudge pair 4 dropped      #
###################################
# Pair 4 lost 11 verdicts to ctx=16384 overflow on long v14 predictions.
# Reload qwen at 32k, re-run judge pass. llm-cache replays predictions
# byte-identical; only judge calls hit qwen.
echo ""
echo "################ A: Rejudge LoCoMo v14-strict ################"
load_qwen
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_JUDGE=strict LOTL_LOCOMO_WORKERS=1 \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v14-strict-rejudge" 2>&1 | tee "$LOG_DIR/A-rejudge.log"

###################################
# B — Gemma validation (4 pairs)  #
###################################
# Skip via SKIP_GEMMA=1 if LM Studio is unstable w/ gemma-26b-a4b load.
if [ "${SKIP_GEMMA:-0}" = "1" ]; then
  echo ""
  echo "################ B: Gemma validation — SKIPPED via SKIP_GEMMA=1 ################"
else
  echo ""
  echo "################ B: Gemma validation ################"
  bash evaluate/scripts/smoke-gemma-validate.sh 2>&1 | tee "$LOG_DIR/B-gemma.log"
fi

###################################
# C — Fill LoCoMo ablation         #
###################################
# Missing cells of the 2×2 LoCoMo matrix:
#   v11 strict — tests "is v11 + strict judge already lower than we saw w/ lenient?"
#   v14 lenient — tests "is v14 actually better when judge is lenient (matching audit)?"
# Both re-use existing gen predictions from the original smoke via llm-cache.
echo ""
echo "################ C1: LoCoMo v11 strict ################"
load_qwen
LOTL_PROMPT_RULES=v11 LOTL_LOCOMO_JUDGE=strict LOTL_LOCOMO_WORKERS=1 \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v11-strict-rejudge" 2>&1 | tee "$LOG_DIR/C1-v11-strict.log"

echo ""
echo "################ C2: LoCoMo v14 lenient ################"
load_qwen
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_JUDGE=lenient LOTL_LOCOMO_WORKERS=1 \
  npx tsx evaluate/locomo/eval.mts \
    --limit 5 --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "smoke-v14-lenient-rejudge" 2>&1 | tee "$LOG_DIR/C2-v14-lenient.log"

unload_all_instances "$JUDGE_MODEL"

echo ""
echo "===== SMOKE FOLLOW-UP DONE ($(date)) ====="
echo "Results:"
ls -la evaluate/locomo/results-smoke-*-rejudge.json 2>/dev/null
ls -la evaluate/longmemeval/results-gemma-*.json 2>/dev/null
ls -la evaluate/locomo/results-gemma-*.json 2>/dev/null
