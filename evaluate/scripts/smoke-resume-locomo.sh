#!/usr/bin/env bash
# Resume smoke from pair 3 (LoCoMo pairs only) after killing the original
# smoke mid-flight. Loads llama with parallel=8 slots and runs with
# LOTL_LME_WORKERS=8 client-side, so both server and client saturate.
# Qwen judge stays at parallel=1 — it's GPU-bound already.

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

# VRAM budget on the 3090 (24 GB): llama weights 4.92 GB, kv-cache 131 KB/token/slot.
# Use a larger `parallel` when context can be smaller — same total kv-cache, more
# concurrent slots = more throughput. Qwen solo uses ~24 GB so parallel=1.
CTX_V11=8192
PARALLEL_V11=16
CTX_V14=10240
PARALLEL_V14=12
PARALLEL_QWEN=1
CTX_QWEN=16384

TS=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/smoke-resume-$TS"
mkdir -p "$LOG_DIR"
echo "Log dir: $LOG_DIR"

# Unload every :N suffix variant so bare-name routing is deterministic.
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
unload()      { curl -fsS -X POST "http://$HOST/api/v1/models/unload" -H "Content-Type: application/json" -d "{\"instance_id\":\"$1\"}" >&2; echo >&2; }

# Clean any leftover llama / qwen instances first — prior smoke may have spawned duplicates.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

run_pair_locomo() {
  local tag="$1" rules="$2" judge="$3"
  # Pick ctx/parallel per prompt version. v11 fits in 8k → 16 slots.
  # v14 CoT needs ~10k → 12 slots. Match LOTL_LME_WORKERS to parallel.
  local ctx parallel
  if [ "$rules" = "v14" ]; then ctx=$CTX_V14; parallel=$PARALLEL_V14; else ctx=$CTX_V11; parallel=$PARALLEL_V11; fi

  echo ""
  echo "################ PAIR: locomo $tag (rules=$rules, judge=$judge, ctx=$ctx, parallel=$parallel) ################"

  load_llama "$ctx" "$parallel"

  echo "===== [LoCoMo-$tag] gen pass ====="
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_WORKERS="$parallel" LOTL_LMSTUDIO_CTX="$ctx" \
    npx tsx evaluate/locomo/eval.mts \
      --limit 5 --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/locomo-$tag-gen.log"

  unload "$GEN_MODEL"

  load_qwen

  echo "===== [LoCoMo-$tag] judge pass (LOTL_LOCOMO_JUDGE=$judge) ====="
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_JUDGE="$judge" LOTL_LOCOMO_WORKERS="$PARALLEL_QWEN" \
    npx tsx evaluate/locomo/eval.mts \
      --limit 5 --llm lmstudio \
      --judge lmstudio --judge-model "$JUDGE_MODEL" \
      --tag "smoke-$tag-pass2" 2>&1 | tee "$LOG_DIR/locomo-$tag-judge.log"

  unload "$JUDGE_MODEL"
}

# Pairs 3 + 4 — LoCoMo only, original pairs 1+2 already cached.
run_pair_locomo v11-lenient v11  lenient
run_pair_locomo v14-strict  v14  strict

echo ""
echo "===== RESUME SMOKE DONE ($(date)) ====="
ls -la evaluate/locomo/results-sweep-smoke-*.json 2>/dev/null
