#!/usr/bin/env bash
# Two-pass LongMemEval runner against an LM Studio server.
#
# Pass 1: load the generator model, run eval --llm lmstudio (no judge), persist
#         every answer to answer-cache/ via persistAnswer(). Unload gen model.
# Pass 2: load the judge model, re-run eval --judge lmstudio on the same subset.
#         Predictions come from the llm cache (deterministic replay at temp=0).
#
# Env overrides:
#   LOTL_LMSTUDIO_HOST         (default 10.0.0.105:1234)
#   LOTL_LMSTUDIO_GEN_MODEL    (default meta-llama-3.1-8b-instruct)
#   LOTL_LMSTUDIO_JUDGE_MODEL  (default qwen/qwen3.6-35b-a3b)
#   LOTL_PROMPT_RULES          (default v14 — the audit CoT prompt)
#   LOTL_LME_LIMIT             (default 20 — keep small while iterating)
#   LOTL_LME_DS                (default oracle — use `s` for full retrieval)

set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
GEN_MODEL="${LOTL_LMSTUDIO_GEN_MODEL:-meta-llama-3.1-8b-instruct}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}"
export LOTL_PROMPT_RULES="${LOTL_PROMPT_RULES:-v14}"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
# No real API key required but askLLM checks for one; any non-empty value works.
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on

LIMIT="${LOTL_LME_LIMIT:-20}"
DS="${LOTL_LME_DS:-oracle}"

TAG="${1:-lmstudio-$(date +%Y%m%d-%H%M%S)}"

CTX="${LOTL_LMSTUDIO_CTX:-16384}"
# Unload every :N suffix first to prevent request routing to stale instances.
unload_all_instances() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}
load_model() {
  local model="$1"
  unload_all_instances "$model"
  local resp
  resp=$(curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"context_length\":$CTX}")
  echo "[load] $model (ctx=$CTX): $resp" >&2
  echo "$model"
}

# LM Studio unload requires instance_id, not model name.
unload_instance() {
  local instance_id="$1"
  [ -z "$instance_id" ] && { echo "[unload] skip — no instance_id"; return 0; }
  curl -fsS -X POST "http://$HOST/api/v1/models/unload" \
    -H "Content-Type: application/json" \
    -d "{\"instance_id\":\"$instance_id\"}" | head -c 400
  echo ""
}

echo "===== Pass 1: load gen model and generate answers ====="
GEN_INSTANCE=$(load_model "$GEN_MODEL" | tail -1)
echo "gen instance_id=$GEN_INSTANCE"

# Pass 1 — generation only. --llm lmstudio → askLLM routes to askOpenAICompat
# with the gen model URL + key. Answers persisted to answer-cache/ per-question.
npx tsx evaluate/longmemeval/eval.mts \
  --ds "$DS" --limit "$LIMIT" --llm lmstudio \
  --tag "$TAG-pass1"

echo "===== Pass 1 done. Unloading gen instance $GEN_INSTANCE ====="
unload_instance "$GEN_INSTANCE"

echo "===== Pass 2: load judge model and judge predictions ====="
JUDGE_INSTANCE=$(load_model "$JUDGE_MODEL" | tail -1)
echo "judge instance_id=$JUDGE_INSTANCE"

# Pass 2 — same --llm (so cache hits rebuild predictions deterministically)
# plus --judge lmstudio and --judge-model override. Temp=0 + same seed means
# the gen model isn't actually called — llmCache replays every prediction.
LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL" \
  npx tsx evaluate/longmemeval/eval.mts \
  --ds "$DS" --limit "$LIMIT" --llm lmstudio \
  --judge lmstudio --judge-model "$JUDGE_MODEL" \
  --tag "$TAG-pass2"

echo "===== Pass 2 done. Unloading judge instance $JUDGE_INSTANCE ====="
unload_instance "$JUDGE_INSTANCE"

echo "Results:"
echo "  pass1 gen → evaluate/longmemeval/results-sweep-$TAG-pass1.json"
echo "  pass2 judge → evaluate/longmemeval/results-sweep-$TAG-pass2.json"
echo "  answers cached → evaluate/longmemeval/answer-cache/lmstudio-*.json"
