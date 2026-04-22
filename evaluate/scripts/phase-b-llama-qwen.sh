#!/usr/bin/env bash
# Phase B — llama+qwen cross-stack baseline (mirror of phase-b-gemma.sh).
#
# Used to answer "does gemma actually win at scale?" by running the exact
# same workload with the prior-generation stack, same prompts, same judge
# methodology. Fair comparison needs n=500 LME + n=200 LoCoMo on both stacks.
#
# Stack:
#   Gen:     meta-llama-3.1-8b-instruct (Q4_K_M, parallel=8 ctx=98304 — v14 CoT needs ~12k/slot)
#   Judge:   qwen/qwen3.6-35b-a3b       (Q4_K_M solo, ctx=32768, parallel=1)
#   Prompt:  v14 CoT
#   Judge:   strict
#   Cache:   separate llm-cache-llama-qwen.json
#   Swaps:   3s VRAM settle between model loads
#
# Output tags:
#   evaluate/longmemeval/results-phase-b-lme-v14-llama-qwen-pass{1,2}.json
#   evaluate/locomo/results-phase-b-locomo-v14-llama-qwen-pass{1,2}.json

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.113:1234}"
GEN_MODEL="meta-llama-3.1-8b-instruct"
JUDGE_MODEL="qwen/qwen3.6-35b-a3b"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
# Load-bearing (see devnotes/architecture/testing-runbook.md).
export LOTL_RECALL_NO_TOUCH=on

# Llama is a non-thinking model — v11 doesn't need the gemma-style 1536 floor.
# v14 CoT defaults to 2560 in eval.mts which is enough.
# No LOTL_ANSWER_MAX_TOKENS override → defaults kick in per prompt version.

export LOTL_LLM_CACHE_PATH="$PWD/evaluate/longmemeval/llm-cache-llama-qwen.json"

# VRAM (3090 24 GB):
#   llama-3.1-8B Q4: ~5 GB weights + 8 × 12288 × 131 KB = ~13 GB kv → ~18 GB total
#   qwen-35B Q4 solo: ~22 GB + ~2 GB kv = 24 GB (tight, parallel=1 only)
CTX_GEN=98304   # 12k/slot × 8 slots — v14 CoT headroom
PARALLEL_GEN=8
CTX_JUDGE=32768 # solo, generous ceiling for long v14 predictions as judge input
PARALLEL_JUDGE=1

LME_LIMIT="${LOTL_LME_LIMIT:-500}"
LOCOMO_LIMIT="${LOTL_LOCOMO_LIMIT:-20}"

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/phase-b-llama-qwen-$TS"
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
load_gen() {
  unload_all_instances "$JUDGE_MODEL"
  unload_all_instances "$GEN_MODEL"
  sleep 3
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$GEN_MODEL\",\"context_length\":$CTX_GEN,\"parallel\":$PARALLEL_GEN}" >&2
  echo "[loaded] $GEN_MODEL ctx=$CTX_GEN parallel=$PARALLEL_GEN" >&2
}
load_judge() {
  unload_all_instances "$GEN_MODEL"
  unload_all_instances "$JUDGE_MODEL"
  sleep 3
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX_JUDGE,\"parallel\":$PARALLEL_JUDGE}" >&2
  echo "[loaded] $JUDGE_MODEL ctx=$CTX_JUDGE parallel=$PARALLEL_JUDGE" >&2
}

echo ""
echo "################ Phase B llama+qwen — LME n=$LME_LIMIT v14 CoT strict ################"
load_gen
LOTL_PROMPT_RULES=v14 LOTL_LME_WORKERS=$PARALLEL_GEN LOTL_LMSTUDIO_CTX=$CTX_GEN \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
    --tag "phase-b-lme-v14-llama-qwen-pass1" 2>&1 | tee "$LOG_DIR/lme-v14-gen.log"

load_judge
LOTL_PROMPT_RULES=v14 LOTL_LME_WORKERS=$PARALLEL_JUDGE \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "phase-b-lme-v14-llama-qwen-pass2" 2>&1 | tee "$LOG_DIR/lme-v14-judge.log"

export LOTL_LLM_CACHE_PATH="$PWD/evaluate/locomo/llm-cache-llama-qwen.json"

echo ""
echo "################ Phase B llama+qwen — LoCoMo --limit $LOCOMO_LIMIT v14 CoT strict ################"
load_gen
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_WORKERS=$PARALLEL_GEN LOTL_LMSTUDIO_CTX=$CTX_GEN \
  npx tsx evaluate/locomo/eval.mts \
    --limit "$LOCOMO_LIMIT" --llm lmstudio \
    --tag "phase-b-locomo-v14-llama-qwen-pass1" 2>&1 | tee "$LOG_DIR/locomo-v14-gen.log"

load_judge
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_JUDGE=strict LOTL_LOCOMO_WORKERS=$PARALLEL_JUDGE \
  npx tsx evaluate/locomo/eval.mts \
    --limit "$LOCOMO_LIMIT" --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "phase-b-locomo-v14-llama-qwen-pass2" 2>&1 | tee "$LOG_DIR/locomo-v14-judge.log"

unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

echo ""
echo "===== PHASE B LLAMA+QWEN DONE ($(date)) ====="
echo "LME:    evaluate/longmemeval/results-phase-b-lme-v14-llama-qwen-pass{1,2}.json"
echo "LoCoMo: evaluate/locomo/results-phase-b-locomo-v14-llama-qwen-pass{1,2}.json"
echo ""
echo "Compare vs gemma via:"
echo "  node evaluate/scripts/wilson-ci.mjs --compare \\"
echo "    evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass2.json \\"
echo "    evaluate/longmemeval/results-phase-b-lme-v14-llama-qwen-pass2.json"
