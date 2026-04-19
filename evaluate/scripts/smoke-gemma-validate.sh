#!/usr/bin/env bash
# Validate gemma-4 models as a drop-in replacement for llama+qwen.
#
# Gen:   google/gemma-4-e4b           (Matformer effective-4B, ~3-4 GB Q4)
# Judge: google/gemma-4-26b-a4b       (MoE, 4B active, ~17 GB Q4, fits ~4 parallel slots)
#
# Runs the same 4 pairs as smoke-all-lmstudio.sh on the same LME/LoCoMo subsets,
# so we can compare per-pair judge/F1 numbers directly against the llama+qwen
# baseline. Decision rule: if gemma is within ~3pp across the board, switch
# Phase B to gemma (speeds judge 4-5× + gen slightly).
#
# Prereq: llama+qwen baseline run must have completed (results-smoke-*.json).
# The gemma run uses separate tags (prefix "gemma-") so results don't collide.

set -uo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
GEN_MODEL="${LOTL_LMSTUDIO_GEN_MODEL:-google/gemma-4-e4b}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-google/gemma-4-26b-a4b}"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on

# Gemma-4-e4b is a thinking model — burns reasoning tokens before emitting
# content. v11's default 128-token budget gets consumed by "Thinking Process:"
# scaffolding, leaving 0 tokens for actual answer → all predictions empty.
# Floor at 1536 so even thinking + answer fits. LOTL_ANSWER_MAX_TOKENS is
# applied as a floor in eval.mts (v14's 2560 default still wins over 1536).
export LOTL_ANSWER_MAX_TOKENS="${LOTL_ANSWER_MAX_TOKENS:-1536}"

# Separate cache file for gemma runs — keeps stale empty-content entries
# from previous gemma attempts out of the canonical llama/qwen cache, and
# lets pass 2 (judge) cache-hit pass 1's (gen) predictions without needing
# gemma-4-e4b to stay loaded during the judge pass. Path is eval-specific.
export LOTL_LLM_CACHE_PATH="${LOTL_LLM_CACHE_PATH:-$PWD/evaluate/longmemeval/llm-cache-gemma.json}"
# Locomo eval uses the same env var but a different default — override for LoCoMo pairs below.

# Gemma budget — tuned after 2026-04-19 crash (LM Studio / driver OOM when
# gemma-4-26b-a4b loaded at ctx=131072 parallel=4 = ~27.5 GB on 24 GB 3090).
# Gen side was fine; only judge needed a nudge. Reductions are ~10% not 50%:
#   gemma-4-e4b gen: parallel=16 @ 8k/slot = 16 × 1 GB kv + 4 GB = ~20 GB ✓
#   gemma-4-26b-a4b judge: parallel=3 @ 16k/slot = 3 × 1.3 GB kv + 17 GB = ~21 GB ✓
# v11 gen at parallel=8 (was 16) — LoCoMo prompts w/ gemma tokenizer push
# past 8k per slot. 16k/slot at parallel=8 fits within gemma-e4b's 131072 max.
CTX_V11_GEN="${LOTL_GEMMA_CTX_V11:-131072}"     # 16k per slot × 8 slots
PARALLEL_V11_GEN="${LOTL_GEMMA_PARALLEL_V11:-8}"
CTX_V14_GEN="${LOTL_GEMMA_CTX_V14:-131072}"     # 16k per slot × 8 slots (unchanged)
PARALLEL_V14_GEN="${LOTL_GEMMA_PARALLEL_V14:-8}"
CTX_JUDGE="${LOTL_GEMMA_CTX_JUDGE:-49152}"      # 16k per slot × 3 slots — was 32k/slot × 4 before crash
PARALLEL_JUDGE="${LOTL_GEMMA_PARALLEL_JUDGE:-3}"

LME_LIMIT="${LOTL_LME_LIMIT:-20}"
LOCOMO_LIMIT="${LOTL_LOCOMO_LIMIT:-5}"

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-gemma-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

# Unload every known heavy model before we start — no cross-model VRAM bleed.
unload_all() {
  for model in "meta-llama-3.1-8b-instruct" "qwen/qwen3.6-35b-a3b" \
               "google/gemma-4-e4b" "google/gemma-4-26b-a4b" "google/gemma-4-31b"; do
    for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
      curl -s -X POST "http://$HOST/api/v1/models/unload" \
        -H "Content-Type: application/json" \
        -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
    done
  done
}
# 3s settle after unload — LM Studio sometimes needs time to fully release
# VRAM before the next load. Without this, a ~20 GB load right after a
# ~20 GB unload can oversubscribe the GPU during the brief overlap window
# and crash the server (caught 2026-04-19 at pair 2 judge boundary).
load_gen() {
  local ctx="$1" parallel="$2"
  unload_all
  sleep 3
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$GEN_MODEL\",\"context_length\":$ctx,\"parallel\":$parallel}" >&2
  echo "[loaded] $GEN_MODEL ctx=$ctx parallel=$parallel" >&2
}
load_judge() {
  unload_all
  sleep 3
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX_JUDGE,\"parallel\":$PARALLEL_JUDGE}" >&2
  echo "[loaded] $JUDGE_MODEL ctx=$CTX_JUDGE parallel=$PARALLEL_JUDGE" >&2
}

unload_all

run_lme_pair() {
  local tag="$1" rules="$2"
  local ctx parallel
  if [ "$rules" = "v14" ]; then ctx=$CTX_V14_GEN; parallel=$PARALLEL_V14_GEN; else ctx=$CTX_V11_GEN; parallel=$PARALLEL_V11_GEN; fi

  echo ""
  echo "################ PAIR: lme gemma-$tag (rules=$rules, ctx=$ctx, parallel=$parallel) ################"

  load_gen "$ctx" "$parallel"
  LOTL_PROMPT_RULES="$rules" LOTL_LME_WORKERS="$parallel" LOTL_LMSTUDIO_CTX="$ctx" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
      --tag "gemma-$tag-pass1" 2>&1 | tee "$LOG_DIR/lme-gemma-$tag-gen.log"

  load_judge
  LOTL_PROMPT_RULES="$rules" LOTL_LME_WORKERS="$PARALLEL_JUDGE" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit "$LME_LIMIT" --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "gemma-$tag-pass2" 2>&1 | tee "$LOG_DIR/lme-gemma-$tag-judge.log"
}

run_locomo_pair() {
  local tag="$1" rules="$2" judge="$3"
  local ctx parallel
  if [ "$rules" = "v14" ]; then ctx=$CTX_V14_GEN; parallel=$PARALLEL_V14_GEN; else ctx=$CTX_V11_GEN; parallel=$PARALLEL_V11_GEN; fi

  echo ""
  echo "################ PAIR: locomo gemma-$tag (rules=$rules, judge=$judge, ctx=$ctx, parallel=$parallel) ################"

  load_gen "$ctx" "$parallel"
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_WORKERS="$parallel" LOTL_LMSTUDIO_CTX="$ctx" \
    npx tsx evaluate/locomo/eval.mts \
      --limit "$LOCOMO_LIMIT" --llm lmstudio \
      --tag "gemma-$tag-pass1" 2>&1 | tee "$LOG_DIR/locomo-gemma-$tag-gen.log"

  load_judge
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_JUDGE="$judge" LOTL_LOCOMO_WORKERS="$PARALLEL_JUDGE" \
    npx tsx evaluate/locomo/eval.mts \
      --limit "$LOCOMO_LIMIT" --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "gemma-$tag-pass2" 2>&1 | tee "$LOG_DIR/locomo-gemma-$tag-judge.log"
}

run_lme_pair    v11          v11
run_lme_pair    v14-cot      v14
run_locomo_pair v11-lenient  v11  lenient
run_locomo_pair v14-strict   v14  strict

unload_all

echo ""
echo "===== GEMMA VALIDATE DONE ($(date)) ====="
echo "LME:   evaluate/longmemeval/results-gemma-*.json"
echo "LoCoMo: evaluate/locomo/results-gemma-*.json"
