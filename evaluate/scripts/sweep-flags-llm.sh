#!/usr/bin/env bash
# Same shape as sweep-flags.sh but runs with --llm gemini --judge gemini.
# Uses the shipped ~/.config/lotl/.env for GOOGLE_API_KEY.
#
# Usage: sweep-flags-llm.sh <config> [--corpus lme|locomo] [--limit N] [--name NAME]
# Gemini-flash free tier handles n=100 eval (~200 calls) easily.

set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$(pwd)

CONFIG_FILE=${1:?"usage: sweep-flags-llm.sh <config-file> [--corpus ...] [--limit N] [--name NAME]"}
shift

CORPUS=lme
LIMIT=100
NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --corpus) CORPUS=$2; shift 2 ;;
    --limit) LIMIT=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$NAME" ]] && NAME=$(basename "$CONFIG_FILE" .txt)-llm

SWEEP_DIR="$REPO/evaluate/sweeps/${NAME}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SWEEP_DIR"
cp "$CONFIG_FILE" "$SWEEP_DIR/config.txt"
echo "Sweep (LLM): $SWEEP_DIR"
echo "Corpus: $CORPUS, Limit: $LIMIT, LLM: gemini, Judge: gemini"

# Ensure env is loaded (eval.mts reads ~/.config/lotl/.env, but the shell
# wrapper needs it too for the preflight probe).
if [[ -f "$HOME/.config/lotl/.env" ]]; then
  set -a
  . "$HOME/.config/lotl/.env"
  set +a
fi

if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "GOOGLE_API_KEY missing — aborting LLM sweep" >&2
  exit 1
fi

export LOTL_EMBED_BACKEND=transformers
export LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1
export LOTL_TRANSFORMERS_DTYPE=q8
export LOTL_EMBED_MAX_WORKERS=4
export LOTL_EMBED_MICROBATCH=32
export OMP_NUM_THREADS=4

run_one_lme() {
  local tag=$1; local overlay=$2
  local outDir="$SWEEP_DIR/$tag"
  mkdir -p "$outDir"
  echo ""
  echo "=== [$tag] LME n=$LIMIT  overlay: ${overlay:-<none>} ==="
  local t0=$(date +%s)
  env $overlay npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit "$LIMIT" --workers 4 \
    --db-suffix mxbai-n500-v17 \
    --tag "sweep-llm-$tag" \
    --llm gemini --judge gemini 2>&1 | tee "$outDir/lme.log"
  local t1=$(date +%s); local elapsed=$((t1 - t0))
  if [[ -f "$REPO/evaluate/longmemeval/results-sweep-llm-$tag.json" ]]; then
    cp "$REPO/evaluate/longmemeval/results-sweep-llm-$tag.json" "$outDir/lme.json"
  fi
  echo "$elapsed" > "$outDir/lme.wall"
  echo "$overlay" > "$outDir/overlay"
  echo "--- $tag elapsed: ${elapsed}s"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%%#*}
  line=$(echo "$line" | sed 's/[[:space:]]*$//')
  [[ -z "${line// }" ]] && continue
  tag=$(echo "$line" | awk '{print $1}')
  overlay=$(echo "$line" | cut -d' ' -f2- | sed 's/^[[:space:]]*//')
  [[ "$overlay" == "$tag" ]] && overlay=""

  if [[ "$CORPUS" == "lme" || "$CORPUS" == "both" ]]; then
    run_one_lme "$tag" "$overlay"
  fi
done < "$CONFIG_FILE"

echo ""
echo "=== Sweep (LLM) complete: $SWEEP_DIR ==="
node evaluate/scripts/summarize-sweep.mjs "$SWEEP_DIR"
