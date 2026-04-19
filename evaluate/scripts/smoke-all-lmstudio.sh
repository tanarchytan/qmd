#!/usr/bin/env bash
# Phase A smoke test — LM Studio end-to-end on both benchmarks at small scale.
# Kicks off 4 runs sequentially (LM Studio can only hold one model at a time
# on a single 3090): LME-v11, LME-v14, LoCoMo-v11-lenient, LoCoMo-v14-strict.
#
# Each run does load-gen / unload / load-judge / unload. Llm-cache persists
# between runs so pass 2 replays pass 1 answers without re-hitting llama.
# Total expected wall: ~2.5h. Safe to run in parallel with the rerank sweep —
# LM Studio is on 10.0.0.105 (separate GPU).

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

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-lmstudio-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

# context_length=16384 fits our longest prompt (v14 CoT + oracle memories ~5-8k tokens)
# plus the 2560-token v14 output budget. LM Studio's default is 4096 which fails
# with "n_keep >= n_ctx" on any non-trivial memory-system prompt.
CTX="${LOTL_LMSTUDIO_CTX:-16384}"
load_model()    { curl -fsS -X POST "http://$HOST/api/v1/models/load"   -H "Content-Type: application/json" -d "{\"model\":\"$1\",\"context_length\":$CTX}" >&2; echo >&2; }
unload_model()  { curl -fsS -X POST "http://$HOST/api/v1/models/unload" -H "Content-Type: application/json" -d "{\"instance_id\":\"$1\"}" >&2; echo >&2; }

run_lme() {
  local tag="$1" rules="$2"
  echo "===== [LME-$tag] gen pass (rules=$rules, n=20 oracle) ====="
  LOTL_PROMPT_RULES="$rules" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit 20 --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/lme-$tag-gen.log"
}

run_lme_judge() {
  local tag="$1" rules="$2"
  echo "===== [LME-$tag] judge pass ====="
  LOTL_PROMPT_RULES="$rules" \
    npx tsx evaluate/longmemeval/eval.mts \
      --ds oracle --limit 20 --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "smoke-$tag-pass2" 2>&1 | tee "$LOG_DIR/lme-$tag-judge.log"
}

run_locomo() {
  local tag="$1" rules="$2"
  echo "===== [LoCoMo-$tag] gen pass (rules=$rules, 5 Q/conv) ====="
  LOTL_PROMPT_RULES="$rules" \
    npx tsx evaluate/locomo/eval.mts \
      --limit 5 --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/locomo-$tag-gen.log"
}

run_locomo_judge() {
  local tag="$1" rules="$2" judge="$3"
  echo "===== [LoCoMo-$tag] judge pass (LOTL_LOCOMO_JUDGE=$judge) ====="
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_JUDGE="$judge" \
    npx tsx evaluate/locomo/eval.mts \
      --limit 5 --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "smoke-$tag-pass2" 2>&1 | tee "$LOG_DIR/locomo-$tag-judge.log"
}

run_pair() {
  local tag="$1" bench="$2" rules="$3" judge="${4:-lenient}"
  echo ""
  echo "################ PAIR: $bench $tag (rules=$rules, judge=$judge) ################"
  load_model "$GEN_MODEL"
  if [ "$bench" = "lme" ]; then run_lme "$tag" "$rules"; else run_locomo "$tag" "$rules"; fi
  unload_model "$GEN_MODEL"
  load_model "$JUDGE_MODEL"
  if [ "$bench" = "lme" ]; then run_lme_judge "$tag" "$rules"; else run_locomo_judge "$tag" "$rules" "$judge"; fi
  unload_model "$JUDGE_MODEL"
}

# 4 smoke configurations.
run_pair v11           lme    v11
run_pair v14-cot       lme    v14
run_pair v11-lenient   locomo v11  lenient
run_pair v14-strict    locomo v14  strict

echo ""
echo "===== ALL 4 SMOKE PAIRS DONE ($(date)) ====="
echo "Logs: $LOG_DIR"
ls -la evaluate/longmemeval/results-sweep-smoke-*.json 2>/dev/null
ls -la evaluate/locomo/results-sweep-smoke-*.json 2>/dev/null
