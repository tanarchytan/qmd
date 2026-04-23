#!/usr/bin/env bash
# Rejudge a prior eval run after judge failures (ctx overflow, unparseable, etc).
# llm-cache hits on every prediction (temp=0 + seed=42 → deterministic) so gen
# doesn't re-run; only judge calls hit the loaded judge model.
#
# Usage:
#   bash evaluate/scripts/rejudge-failed.sh <bench> <tag> [flags]
#
#   bench: lme | locomo
#   tag:   original pass1 tag (e.g. smoke-v14-strict or phase-b-locomo-v14-gemma)
#
# Flags (all optional — env-var fallbacks in parens):
#   --rules v11|v14           (LOTL_PROMPT_RULES)
#   --judge strict|lenient    (LoCoMo only — LOTL_LOCOMO_JUDGE)
#   --judge-model <model-id>  (LOTL_LMSTUDIO_JUDGE_MODEL; default qwen/qwen3.6-35b-a3b)
#   --gen-model <model-id>    (LOTL_LMSTUDIO_GEN_MODEL; default meta-llama-3.1-8b-instruct)
#   --cache-path <path>       (LOTL_LLM_CACHE_PATH; default per-benchmark hardcoded)
#   --judge-ctx <tokens>      (LOTL_LMSTUDIO_CTX_JUDGE; default 32768)
#   --judge-parallel <n>      (LOTL_LMSTUDIO_PARALLEL_JUDGE; default 1)
#
# Examples:
#   # Original qwen rejudge (LoCoMo v14 strict):
#   bash evaluate/scripts/rejudge-failed.sh locomo smoke-v14-strict \
#     --rules v14 --judge strict
#
#   # Phase B gemma rejudge with schema-enforced JSON:
#   bash evaluate/scripts/rejudge-failed.sh locomo phase-b-locomo-v14-gemma \
#     --rules v14 --judge strict \
#     --judge-model google/gemma-4-26b-a4b \
#     --cache-path evaluate/locomo/llm-cache-gemma.json \
#     --judge-ctx 49152 --judge-parallel 3

set -uo pipefail
cd "$(dirname "$0")/../.."

BENCH="${1:-}"
TAG="${2:-}"
RULES="${LOTL_PROMPT_RULES:-v11}"
JUDGE_STRICTNESS="${LOTL_LOCOMO_JUDGE:-lenient}"
JUDGE_MODEL_FLAG=""
GEN_MODEL_FLAG=""
CACHE_PATH_FLAG=""
JUDGE_CTX_FLAG=""
JUDGE_PARALLEL_FLAG=""
shift 2 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rules)           RULES=$2;               shift 2 ;;
    --judge)           JUDGE_STRICTNESS=$2;    shift 2 ;;
    --judge-model)     JUDGE_MODEL_FLAG=$2;    shift 2 ;;
    --gen-model)       GEN_MODEL_FLAG=$2;      shift 2 ;;
    --cache-path)      CACHE_PATH_FLAG=$2;     shift 2 ;;
    --judge-ctx)       JUDGE_CTX_FLAG=$2;      shift 2 ;;
    --judge-parallel)  JUDGE_PARALLEL_FLAG=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$BENCH" || -z "$TAG" ]]; then
  sed -n '2,29p' "$0" >&2
  exit 2
fi

HOST="${LOTL_LMSTUDIO_HOST:-localhost:1234}"
# Flag wins; env is fallback; built-in default is final.
JUDGE_MODEL="${JUDGE_MODEL_FLAG:-${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}}"
GEN_MODEL="${GEN_MODEL_FLAG:-${LOTL_LMSTUDIO_GEN_MODEL:-meta-llama-3.1-8b-instruct}}"
JUDGE_CTX="${JUDGE_CTX_FLAG:-${LOTL_LMSTUDIO_CTX_JUDGE:-32768}}"
JUDGE_PARALLEL="${JUDGE_PARALLEL_FLAG:-${LOTL_LMSTUDIO_PARALLEL_JUDGE:-1}}"

# Export so eval.mts picks up the right gen/judge models. If we don't export
# the gen model, any cache miss triggers LM Studio to auto-load the llama
# default at ctx=4096 → overflow cascade (caught 2026-04-19).
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_LMSTUDIO_GEN_MODEL="$GEN_MODEL"
export LOTL_LMSTUDIO_JUDGE_MODEL="$JUDGE_MODEL"
export LOTL_SKIP_PREFLIGHT=on
# Load-bearing — recall must be read-only so the prompt for each question
# is byte-identical to the original pass 1 run. Otherwise access_count bumps
# shift Weibull decay → memory ranking → prompt → cache key all differ.
export LOTL_RECALL_NO_TOUCH=on
[[ -n "$CACHE_PATH_FLAG" ]] && export LOTL_LLM_CACHE_PATH="$CACHE_PATH_FLAG"

unload_all_instances() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}

echo "===== Rejudge $BENCH [$TAG] ====="
echo "  judge model:    $JUDGE_MODEL (ctx=$JUDGE_CTX parallel=$JUDGE_PARALLEL)"
echo "  gen model:      $GEN_MODEL (cache replay only — not actually called unless cache miss)"
echo "  prompt rules:   $RULES"
[[ "$BENCH" = "locomo" ]] && echo "  judge strictness: $JUDGE_STRICTNESS"
[[ -n "$CACHE_PATH_FLAG" ]] && echo "  cache path:     $CACHE_PATH_FLAG"
echo ""

# Clean slate before loading judge — prevent cross-model VRAM bleed (caught
# 2026-04-19 w/ qwen+llama both loaded → crash).
for m in "meta-llama-3.1-8b-instruct" "qwen/qwen3.6-35b-a3b" \
         "google/gemma-4-e4b" "google/gemma-4-26b-a4b" "google/gemma-4-31b"; do
  [[ "$m" != "$JUDGE_MODEL" ]] && unload_all_instances "$m"
done
unload_all_instances "$JUDGE_MODEL"
sleep 3
curl -fsS -X POST "http://$HOST/api/v1/models/load" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$JUDGE_CTX,\"parallel\":$JUDGE_PARALLEL}"
echo ""

case "$BENCH" in
  lme)
    LOTL_PROMPT_RULES="$RULES" LOTL_LME_WORKERS="$JUDGE_PARALLEL" \
      npx tsx evaluate/longmemeval/eval.mts \
        --ds oracle --limit "${LOTL_LME_LIMIT:-500}" --llm lmstudio \
        --judge lmstudio --judge-model "$JUDGE_MODEL" \
        --tag "${TAG}-rejudge"
    ;;
  locomo)
    LOTL_PROMPT_RULES="$RULES" LOTL_LOCOMO_JUDGE="$JUDGE_STRICTNESS" LOTL_LOCOMO_WORKERS="$JUDGE_PARALLEL" \
      npx tsx evaluate/locomo/eval.mts \
        --limit "${LOTL_LOCOMO_LIMIT:-20}" --llm lmstudio \
        --judge lmstudio --judge-model "$JUDGE_MODEL" \
        --tag "${TAG}-rejudge"
    ;;
  *)
    echo "unknown bench: $BENCH (use lme or locomo)" >&2
    exit 2
    ;;
esac

unload_all_instances "$JUDGE_MODEL"
echo ""
echo "===== REJUDGE DONE ====="
echo "Wrote: evaluate/$BENCH/results-${TAG}-rejudge.json"
