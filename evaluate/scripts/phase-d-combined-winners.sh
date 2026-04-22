#!/usr/bin/env bash
# Phase D #38 — combined-winners run composing all per-phase winners into one stack.
#
# Stack (all defaults picked from prior stages, no new knobs):
#   Rerank:           jina-reranker-v1-tiny-en (Stage 9 winner, +4.9pp R@5 / +0.052 MRR)
#   Weights:          7/3 BM25/vec RRF (Stage 9 ratio where rerank lift is measured)
#   Generator:        gemma-4-e4b     (Phase B validated)
#   Judge:            gemma-4-26b-a4b (schema-forced JSON, 3-run majority vote)
#   Prompt:           v14 CoT         (audit's answer_prompt_cot)
#   Judge rule:       strict on LoCoMo (drops 6.9x leniency bug per audit)
#   Recall hygiene:   LOTL_RECALL_NO_TOUCH=on (prevents access_count drift mid-eval)
#   Prefix:           LOTL_EVAL_*     (#47 — works via compat bridge with legacy LOTL_*)
#
# Modes:
#   --dry-run       : print the full env stack + exit 0 (safe to run without LM Studio)
#   --smoke         : --limit 20 on both corpora (~10 min wall once LM Studio is back)
#   (default)       : full n=500 LME + --limit 20 LoCoMo conv × 10 = 200 questions
#
# Output tag: phase-d-combined-winners
# Expected wall (LM Studio with gemma-4-e4b @ parallel=8): ~50-60 min.

set -uo pipefail
cd "$(dirname "$0")/../.."

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --smoke)   MODE="smoke" ;;
    --full)    MODE="full" ;;
    *) echo "unknown arg: $arg" >&2; echo "usage: $0 [--dry-run|--smoke|--full]" >&2; exit 2 ;;
  esac
done

HOST="${LOTL_LMSTUDIO_HOST:-10.0.0.113:1234}"

# --- Phase D rerank winner (transformers.js ONNX default) -----------------
export LOTL_MEMORY_RERANK=on
export LOTL_RERANK_BACKEND="${LOTL_RERANK_BACKEND:-transformers}"
export LOTL_TRANSFORMERS_RERANK_MODEL="${LOTL_TRANSFORMERS_RERANK_MODEL:-jinaai/jina-reranker-v1-tiny-en}"
export LOTL_MEMORY_RRF_W_BM25=0.8    # Phase 6 LME winner — was 0.7
export LOTL_MEMORY_RRF_W_VEC=0.2     # Phase 6 LME winner — was 0.3

# --- Phase C judge configuration -----------------------------------------
export LOTL_EVAL_JUDGE_RUNS=3           # majority vote across 3 judge passes
export LOTL_EVAL_LOCOMO_JUDGE=strict    # drop the "touches on topic" leniency
export LOTL_EVAL_PROMPT_RULES=v14       # v14 CoT answer prompt

# --- Phase B gemma gen+judge ---------------------------------------------
export LOTL_EVAL_LMSTUDIO_GEN_MODEL="google/gemma-4-e4b"
export LOTL_EVAL_LMSTUDIO_JUDGE_MODEL="google/gemma-4-26b-a4b"
export LOTL_LMSTUDIO_HOST="$HOST"
export LOTL_LMSTUDIO_KEY="${LOTL_LMSTUDIO_KEY:-lm-studio}"

# --- Recall hygiene (Phase E #39) ----------------------------------------
export LOTL_RECALL_NO_TOUCH=on

# --- Separate cache so this run doesn't collide with other Phase B caches -
export LOTL_LLM_CACHE_PATH="$(pwd)/evaluate/longmemeval/llm-cache-combined-winners.json"

echo "[phase-d-combined-winners] stack assembled:"
echo "  LOTL_MEMORY_RERANK=$LOTL_MEMORY_RERANK"
echo "  LOTL_RERANK_BACKEND=$LOTL_RERANK_BACKEND"
echo "  LOTL_TRANSFORMERS_RERANK_MODEL=$LOTL_TRANSFORMERS_RERANK_MODEL"
echo "  LOTL_MEMORY_RRF_W_BM25/VEC=$LOTL_MEMORY_RRF_W_BM25/$LOTL_MEMORY_RRF_W_VEC"
echo "  LOTL_EVAL_JUDGE_RUNS=$LOTL_EVAL_JUDGE_RUNS"
echo "  LOTL_EVAL_LOCOMO_JUDGE=$LOTL_EVAL_LOCOMO_JUDGE"
echo "  LOTL_EVAL_PROMPT_RULES=$LOTL_EVAL_PROMPT_RULES"
echo "  LOTL_EVAL_LMSTUDIO_GEN_MODEL=$LOTL_EVAL_LMSTUDIO_GEN_MODEL"
echo "  LOTL_EVAL_LMSTUDIO_JUDGE_MODEL=$LOTL_EVAL_LMSTUDIO_JUDGE_MODEL"
echo "  LOTL_LMSTUDIO_HOST=$LOTL_LMSTUDIO_HOST"
echo "  LOTL_RECALL_NO_TOUCH=$LOTL_RECALL_NO_TOUCH"
echo "  LOTL_LLM_CACHE_PATH=$LOTL_LLM_CACHE_PATH"

if [[ "$MODE" == "dry-run" ]]; then
  echo "[phase-d-combined-winners] --dry-run: stack printed above; not firing eval."
  exit 0
fi

# Confirm LM Studio is up before spinning up LLM-dependent eval
if ! curl -sS --max-time 5 -o /dev/null -w "%{http_code}" "http://$HOST/v1/models" | grep -q "^200$"; then
  echo "[phase-d-combined-winners] ERROR: LM Studio at http://$HOST not responding. Re-launch the app." >&2
  exit 1
fi

LIMIT=""
if [[ "$MODE" == "smoke" ]]; then
  LIMIT="--limit 20"
  echo "[phase-d-combined-winners] --smoke mode: n=20 on both corpora"
fi

# Delegate to the existing phase-b-gemma harness; it handles model load/unload
# and cache hygiene. The extra env vars above overlay on top of its defaults.
exec bash evaluate/scripts/phase-b-gemma.sh $LIMIT
