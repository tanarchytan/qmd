#!/usr/bin/env bash
# Phase B — full-scale eval on the gemma stack validated in the Phase A smoke.
#
# Stack (locked in 2026-04-19 smoke):
#   Gen:     google/gemma-4-e4b        (Matformer 4B active, parallel=8 ctx=131072)
#   Judge:   google/gemma-4-26b-a4b    (MoE 26B/4B active, parallel=3 ctx=49152)
#   Prompt:  v14 CoT (audit's answer_prompt_cot)
#   Judge:   strict (audit-corrected, LOTL_LOCOMO_JUDGE=strict on LoCoMo)
#   Cache:   separate llm-cache-gemma.json files per benchmark
#   Swaps:   3s VRAM-release settle between model load/unload
#
# Scale vs smoke:
#   LME:     n=500 (full longmemeval_oracle.json — 20 → 500 = 25×)
#   LoCoMo:  --limit 20 per conv × 10 convs = 200 questions (50 → 200 = 4×)
#
# Expected wall (batched, gemma is fast on 3090):
#   LME n=500 gen:    ~5-8 min
#   LME n=500 judge:  ~10-15 min (qwen was 22s/q serial; gemma parallel=3 ~5s effective)
#   LoCoMo 200 gen:   ~5-8 min
#   LoCoMo 200 judge: ~10-15 min
#   Total ≈ 40-50 min

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-localhost:1234}"
GEN_MODEL="google/gemma-4-e4b"
JUDGE_MODEL="google/gemma-4-26b-a4b"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on
# IMPORTANT: must export so eval.mts picks up gemma models, not the llama default.
# Without these, LME defaults to meta-llama-3.1-8b-instruct which LM Studio
# auto-loads at default ctx=4096 → every prompt overflows → fallback cascade.
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
# Load-bearing — without this, memoryRecall bumps access_count each call, which
# shifts Weibull-decay ranking, which changes retrieved memories, which changes
# the prompt, which misses the llm-cache. Re-runs then try to regenerate via
# auto-loaded models at default ctx=4096 and crash. Documented in
# devnotes/architecture/testing-runbook.md recipe prereqs.
export LOTL_RECALL_NO_TOUCH=on

# Thinking-model token budgets (gemma-4-e4b burns ~300-500 reasoning tokens).
export LOTL_ANSWER_MAX_TOKENS=1536
# Separate cache file so this run doesn't touch llama/qwen cache.
export LOTL_LLM_CACHE_PATH="$PWD/evaluate/longmemeval/llm-cache-gemma.json"

# VRAM-tuned from smoke — fixed at full-power values. Any "night mode" (halved
# parallel) was tested and rejected 2026-04-19: the 3090 fan is audibly loud
# even at parallel=1. Pause-window overnight is the chosen quiet strategy
# (kill the run, unload models, resume at 08:30 Amsterdam), not a half-speed
# mode. Keeping a single full-power config keeps the script honest.
CTX_GEN=131072
PARALLEL_GEN=8
CTX_JUDGE=49152
PARALLEL_JUDGE=3

# Scale (override via env if you want a smaller test run)
LME_LIMIT="${LOTL_LME_LIMIT:-500}"
LOCOMO_LIMIT="${LOTL_LOCOMO_LIMIT:-20}"

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/phase-b-$TS"
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

###################
# LME n=500 v14    #
###################
echo ""
echo "################ Phase B — LME n=$LME_LIMIT v14 CoT strict ################"
load_gen
LOTL_PROMPT_RULES=v14 LOTL_LME_WORKERS=$PARALLEL_GEN LOTL_LMSTUDIO_CTX=$CTX_GEN \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
    --tag "phase-b-lme-v14-gemma-pass1" 2>&1 | tee "$LOG_DIR/lme-v14-gen.log"

load_judge
LOTL_PROMPT_RULES=v14 LOTL_LME_WORKERS=$PARALLEL_JUDGE \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "phase-b-lme-v14-gemma-pass2" 2>&1 | tee "$LOG_DIR/lme-v14-judge.log"

# Switch cache file for LoCoMo (separate file, same format)
export LOTL_LLM_CACHE_PATH="$PWD/evaluate/locomo/llm-cache-gemma.json"

####################
# LoCoMo 200 v14    #
####################
echo ""
echo "################ Phase B — LoCoMo --limit $LOCOMO_LIMIT v14 CoT strict ################"
load_gen
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_WORKERS=$PARALLEL_GEN LOTL_LMSTUDIO_CTX=$CTX_GEN \
  npx tsx evaluate/locomo/eval.mts \
    --limit "$LOCOMO_LIMIT" --llm lmstudio \
    --tag "phase-b-locomo-v14-gemma-pass1" 2>&1 | tee "$LOG_DIR/locomo-v14-gen.log"

load_judge
LOTL_PROMPT_RULES=v14 LOTL_LOCOMO_JUDGE=strict LOTL_LOCOMO_WORKERS=$PARALLEL_JUDGE \
  npx tsx evaluate/locomo/eval.mts \
    --limit "$LOCOMO_LIMIT" --llm lmstudio \
    --judge lmstudio --judge-model "$JUDGE_MODEL" \
    --tag "phase-b-locomo-v14-gemma-pass2" 2>&1 | tee "$LOG_DIR/locomo-v14-judge.log"

# Final cleanup
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

echo ""
echo "===== PHASE B DONE ($(date)) ====="
echo "LME:    evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass{1,2}.json"
echo "LoCoMo: evaluate/locomo/results-phase-b-locomo-v14-gemma-pass{1,2}.json"
echo "Logs:   $LOG_DIR"
