#!/usr/bin/env bash
# Phase D #53 — BEIR top-3 GGUF rerank sweep with BEIR-order early stop.
#
# Rule (user-approved 2026-04-21):
#   Run Phase 1 — baseline + jina-tiny + BEIR #1 (jina-v3) + #2 (mxbai-large-v2)
#   + #3 (Qwen3-4B). If MRR drops monotonically from #1 → #2 → #3, BEIR-ranking
#   predicts LoCoMo ordering — stop, lower-ranked models won't win either.
#   If any inversion, fire Phase 2 (4 more configs) to complete the picture.
#
# Wall:
#   Phase 1 only: ~45-60 min (5 configs)
#   Phase 1 + Phase 2: ~90-120 min (9 configs total)

set -uo pipefail
cd "$(dirname "$0")/../.."

CONF_DIR="evaluate/sweeps/configs"
PHASE1_CFG="$CONF_DIR/rerank-lmstudio-gguf-top3.txt"
PHASE2_CFG="$CONF_DIR/rerank-lmstudio-gguf-rest.txt"

echo "[beir-early-stop] firing Phase 1 (baseline + jina-tiny + BEIR #1/#2/#3)"
bash evaluate/scripts/sweep-flags.sh "$PHASE1_CFG" \
  --corpus locomo --name beir-top3-gguf-phase1

PHASE1_DIR=$(ls -dt evaluate/sweeps/beir-top3-gguf-phase1-*/ 2>/dev/null | head -1)
PHASE1_DIR="${PHASE1_DIR%/}"
echo "[beir-early-stop] Phase 1 done: $PHASE1_DIR"

# Pull MRR for the BEIR-ranked configs and decide.
read_mrr() {
  local cfg=$1
  local f="$PHASE1_DIR/$cfg/locomo.json"
  [[ ! -f "$f" ]] && echo "missing" && return
  node -e "const d=JSON.parse(require('fs').readFileSync('$f'));const s=d.summary||{};const v=s.avgMRR;console.log(typeof v==='number'?v.toFixed(4):'no-mrr');"
}

MRR_JINA_V3=$(read_mrr jina-v3-listwise-gguf)
MRR_MXBAI_LARGE=$(read_mrr mxbai-v2-large-gguf)
MRR_QWEN_4B=$(read_mrr qwen3-reranker-4b-gguf)

echo ""
echo "[beir-early-stop] BEIR-ranked MRR on LoCoMo:"
echo "  #1 jina-v3           MRR=$MRR_JINA_V3"
echo "  #2 mxbai-large-v2    MRR=$MRR_MXBAI_LARGE"
echo "  #3 Qwen3-4B          MRR=$MRR_QWEN_4B"

# Decision: if #1 > #2 > #3 strictly, monotonic → stop. Else fire Phase 2.
monotonic=$(node -e "
const a=parseFloat('$MRR_JINA_V3');
const b=parseFloat('$MRR_MXBAI_LARGE');
const c=parseFloat('$MRR_QWEN_4B');
if (isNaN(a) || isNaN(b) || isNaN(c)) { console.log('unknown'); process.exit(0); }
console.log(a > b && b > c ? 'yes' : 'no');
")

echo "  Monotonic #1 > #2 > #3: $monotonic"
echo ""

if [[ "$monotonic" == "yes" ]]; then
  echo "[beir-early-stop] BEIR-order confirmed. Skipping Phase 2 (4 lower-ranked models)."
  echo "[beir-early-stop] Done."
  exit 0
fi

echo "[beir-early-stop] Inversion detected (or data missing). Firing Phase 2."
bash evaluate/scripts/sweep-flags.sh "$PHASE2_CFG" \
  --corpus locomo --name beir-top3-gguf-phase2

echo "[beir-early-stop] Phase 2 done. Full picture in:"
echo "  $PHASE1_DIR"
echo "  $(ls -dt evaluate/sweeps/beir-top3-gguf-phase2-*/ 2>/dev/null | head -1)"
