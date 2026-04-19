#!/usr/bin/env bash
# Two-pass LoCoMo runner against an LM Studio server — baseline with existing
# SQLite dbs. Pass 1: load gen model, generate answers at DEFAULT 9/1 weights.
# Pass 2: unload gen, load judge, re-run (llm-cache replays predictions),
# judge via qwen.
#
# Uses the existing evaluate/locomo/dbs/conv-*-baseline-full.sqlite from prior
# baseline runs — no rebuild required. Skip `--run-id` to let eval.mts pick
# the default pipeline.
#
# Env overrides (same as longmemeval/lmstudio-two-pass.sh):
#   LOTL_LMSTUDIO_HOST         (default 10.0.0.105:1234)
#   LOTL_LMSTUDIO_GEN_MODEL    (default meta-llama-3.1-8b-instruct)
#   LOTL_LMSTUDIO_JUDGE_MODEL  (default qwen/qwen3.6-35b-a3b)
#   LOTL_LOCOMO_CONV_FILTER    (default "" — all 10 convs; e.g. "26,30,41")

set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
GEN_MODEL="${LOTL_LMSTUDIO_GEN_MODEL:-meta-llama-3.1-8b-instruct}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on

TAG="${1:-locomo-lmstudio-baseline-$(date +%Y%m%d-%H%M%S)}"

CTX="${LOTL_LMSTUDIO_CTX:-16384}"
load_model() {
  local model="$1"
  local resp
  resp=$(curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"context_length\":$CTX}")
  echo "[load] $model (ctx=$CTX): $resp" >&2
  echo "$model"
}

unload_instance() {
  local instance_id="$1"
  [ -z "$instance_id" ] && { echo "[unload] skip — no instance_id"; return 0; }
  curl -fsS -X POST "http://$HOST/api/v1/models/unload" \
    -H "Content-Type: application/json" \
    -d "{\"instance_id\":\"$instance_id\"}" | head -c 400
  echo ""
}

echo "===== Pass 1: load gen model and generate answers ====="
GEN_INSTANCE=$(load_model "$GEN_MODEL")

npx tsx evaluate/locomo/eval.mts \
  --llm lmstudio \
  --tag "$TAG-pass1"

echo "===== Pass 1 done. Unloading gen instance $GEN_INSTANCE ====="
unload_instance "$GEN_INSTANCE"

echo "===== Pass 2: load judge model and judge predictions ====="
JUDGE_INSTANCE=$(load_model "$JUDGE_MODEL")

npx tsx evaluate/locomo/eval.mts \
  --llm lmstudio \
  --judge lmstudio --judge-model "$JUDGE_MODEL" \
  --tag "$TAG-pass2"

echo "===== Pass 2 done. Unloading judge instance $JUDGE_INSTANCE ====="
unload_instance "$JUDGE_INSTANCE"

echo "Results:"
echo "  pass1 gen   → evaluate/locomo/results-sweep-$TAG-pass1.json"
echo "  pass2 judge → evaluate/locomo/results-sweep-$TAG-pass2.json"
