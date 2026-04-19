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
# 8 workers for client-side concurrency, matches llama's 8 parallel slots.
export LOTL_LME_WORKERS=8

CTX=16384
PARALLEL_LLAMA=8
# qwen judge stays at parallel=1 — 35B already saturates VRAM
PARALLEL_QWEN=1

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
  unload_all_instances "$GEN_MODEL"
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$GEN_MODEL\",\"context_length\":$CTX,\"parallel\":$PARALLEL_LLAMA}" >&2
  echo >&2
}
load_qwen() {
  unload_all_instances "$JUDGE_MODEL"
  curl -fsS -X POST "http://$HOST/api/v1/models/load" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX,\"parallel\":$PARALLEL_QWEN}" >&2
  echo >&2
}
unload()      { curl -fsS -X POST "http://$HOST/api/v1/models/unload" -H "Content-Type: application/json" -d "{\"instance_id\":\"$1\"}" >&2; echo >&2; }

# Clean any leftover llama / qwen instances first — prior smoke may have spawned duplicates.
unload_all_instances "$GEN_MODEL"
unload_all_instances "$JUDGE_MODEL"

run_pair_locomo() {
  local tag="$1" rules="$2" judge="$3"
  echo ""
  echo "################ PAIR: locomo $tag (rules=$rules, judge=$judge, parallel=$PARALLEL_LLAMA, workers=$LOTL_LME_WORKERS) ################"

  load_llama

  echo "===== [LoCoMo-$tag] gen pass ====="
  LOTL_PROMPT_RULES="$rules" \
    npx tsx evaluate/locomo/eval.mts \
      --limit 5 --llm lmstudio \
      --tag "smoke-$tag-pass1" 2>&1 | tee "$LOG_DIR/locomo-$tag-gen.log"

  unload "$GEN_MODEL"

  load_qwen

  echo "===== [LoCoMo-$tag] judge pass (LOTL_LOCOMO_JUDGE=$judge) ====="
  LOTL_PROMPT_RULES="$rules" LOTL_LOCOMO_JUDGE="$judge" \
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
