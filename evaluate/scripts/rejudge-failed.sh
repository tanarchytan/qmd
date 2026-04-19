#!/usr/bin/env bash
# Rejudge a prior eval run after judge failures (ctx overflow, unparseable, etc).
# llm-cache.json hits on every prediction (temp=0 + seed=42 → deterministic) so
# gen doesn't re-run; only the judge calls hit qwen.
#
# Usage:
#   bash evaluate/scripts/rejudge-failed.sh <bench> <tag> [--rules v11|v14] [--judge strict|lenient]
#
#   bench: lme | locomo
#   tag:   original pass1 tag (e.g. smoke-v14-strict — the script re-judges into <tag>-rejudge)
#
# Example — retry the LoCoMo v14 strict judge pass after ctx=16384 overflow:
#   bash evaluate/scripts/rejudge-failed.sh locomo smoke-v14-strict --rules v14 --judge strict

set -uo pipefail
cd "$(dirname "$0")/../.."

BENCH="${1:-}"
TAG="${2:-}"
RULES="v11"
JUDGE="lenient"
shift 2 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rules) RULES=$2; shift 2 ;;
    --judge) JUDGE=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$BENCH" || -z "$TAG" ]]; then
  echo "Usage: $0 <lme|locomo> <tag> [--rules v11|v14] [--judge strict|lenient]" >&2
  exit 2
fi

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.105:1234}"
JUDGE_MODEL="${LOTL_LMSTUDIO_JUDGE_MODEL:-qwen/qwen3.6-35b-a3b}"
# Bumped to 32k after observing n_keep=18904 overflow on v14 CoT predictions.
CTX_QWEN="${LOTL_LMSTUDIO_CTX_QWEN:-32768}"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"
export LOTL_SKIP_PREFLIGHT=on

unload_all_instances() {
  local model="$1"
  for suffix in "" ":2" ":3" ":4" ":5" ":6" ":7" ":8"; do
    curl -s -X POST "http://$HOST/api/v1/models/unload" \
      -H "Content-Type: application/json" \
      -d "{\"instance_id\":\"${model}${suffix}\"}" >/dev/null 2>&1 || true
  done
}

echo "===== Loading judge $JUDGE_MODEL at ctx=$CTX_QWEN ====="
unload_all_instances "meta-llama-3.1-8b-instruct"
unload_all_instances "google/gemma-4-e4b"
unload_all_instances "$JUDGE_MODEL"
curl -fsS -X POST "http://$HOST/api/v1/models/load" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$JUDGE_MODEL\",\"context_length\":$CTX_QWEN,\"parallel\":1}"
echo ""

case "$BENCH" in
  lme)
    echo "===== Rejudging LME [$TAG] ====="
    LOTL_PROMPT_RULES="$RULES" \
      npx tsx evaluate/longmemeval/eval.mts \
        --ds oracle --limit "${LOTL_LME_LIMIT:-20}" --llm lmstudio \
        --judge lmstudio --judge-model "$JUDGE_MODEL" \
        --tag "${TAG}-rejudge"
    ;;
  locomo)
    echo "===== Rejudging LoCoMo [$TAG] judge=$JUDGE ====="
    LOTL_PROMPT_RULES="$RULES" LOTL_LOCOMO_JUDGE="$JUDGE" LOTL_LOCOMO_WORKERS=1 \
      npx tsx evaluate/locomo/eval.mts \
        --limit "${LOTL_LOCOMO_LIMIT:-5}" --llm lmstudio \
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
