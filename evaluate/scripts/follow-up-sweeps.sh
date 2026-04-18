#!/usr/bin/env bash
# Follow-up stages 7-11. Run AFTER chained-sweeps.sh completes.
# ~2.5 h additional. Kicks off Phase 3 weight-matrix, LoCoMo single-flag
# ablation, LoCoMo weight-paired reranker, LoCoMo MRR drift repro, and
# a cross-corpus combined-winners landing.

set -uo pipefail
cd "$(dirname "$0")/../.."

FOLLOW_ROOT="evaluate/sweeps/followup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$FOLLOW_ROOT"
MASTER="$FOLLOW_ROOT/MASTER.md"

echo "# Follow-up stages 7-11 — $(date)" > "$MASTER"
echo "Anchor log directory: \`$FOLLOW_ROOT\`" >> "$MASTER"

stage() {
  echo "" | tee -a "$MASTER"
  echo "===== [$1] $2 — $(date +%H:%M:%S) =====" | tee -a "$MASTER"
}

record() {
  local tag=$1 exit=$2 dir=${3:-}
  if [[ $exit -eq 0 ]]; then
    echo "  → OK" | tee -a "$MASTER"
    [[ -n "$dir" && -f "$dir/SUMMARY.md" ]] && echo "  → \`$dir/SUMMARY.md\`" | tee -a "$MASTER"
  else
    echo "  → FAILED (exit $exit) — continuing" | tee -a "$MASTER"
  fi
}

# ---------------------------------------------------------------------------
# Stage 7: reranker × 7/3 weight matrix (LME)
# ---------------------------------------------------------------------------
stage "stage7" "LME reranker × 7/3 weight (6 candidates + baseline)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-at-w73.txt \
  --corpus lme --limit 500 --name rerank-at-w73 \
  > "$FOLLOW_ROOT/07-rerank-at-w73.log" 2>&1
S7=$?; D7=$(ls -d evaluate/sweeps/rerank-at-w73-*/ 2>/dev/null | tail -1)
record stage7 $S7 "$D7"

# ---------------------------------------------------------------------------
# Stage 8: Phase 1 equivalent on LoCoMo (9 flags, default weights)
# ---------------------------------------------------------------------------
stage "stage8" "LoCoMo Phase 1 ablation (9 flags, default weights)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-locomo.txt \
  --corpus locomo --name flag-sweep-locomo \
  > "$FOLLOW_ROOT/08-flag-sweep-locomo.log" 2>&1
S8=$?; D8=$(ls -d evaluate/sweeps/flag-sweep-locomo-*/ 2>/dev/null | tail -1)
record stage8 $S8 "$D8"

# ---------------------------------------------------------------------------
# Stage 9: reranker × 7/3 on LoCoMo
# ---------------------------------------------------------------------------
stage "stage9" "LoCoMo reranker × 7/3 weight"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-at-w73.txt \
  --corpus locomo --name rerank-at-w73-locomo \
  > "$FOLLOW_ROOT/09-rerank-at-w73-locomo.log" 2>&1
S9=$?; D9=$(ls -d evaluate/sweeps/rerank-at-w73-locomo-*/ 2>/dev/null | tail -1)
record stage9 $S9 "$D9"

# ---------------------------------------------------------------------------
# Stage 10: LoCoMo MRR drift 5-pass repro
# ---------------------------------------------------------------------------
stage "stage10" "LoCoMo MRR drift — 5 identical passes"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/mrr-drift-locomo-5-passes.txt \
  --corpus locomo --name mrr-drift-locomo \
  > "$FOLLOW_ROOT/10-mrr-drift-locomo.log" 2>&1
S10=$?; D10=$(ls -d evaluate/sweeps/mrr-drift-locomo-*/ 2>/dev/null | tail -1)
record stage10 $S10 "$D10"

# ---------------------------------------------------------------------------
# Stage 11: combined winners on LoCoMo (mirrors Stage 6 on the other corpus)
# ---------------------------------------------------------------------------
stage "stage11" "Combined winners on LoCoMo"

# Reuse the combined-winners config the main chain generated (latest chain dir).
LATEST_CHAIN=$(ls -d evaluate/sweeps/chain-*/ 2>/dev/null | tail -1)
WINNER_CFG="$LATEST_CHAIN/combined-winners.txt"
if [[ -f "$WINNER_CFG" ]]; then
  bash evaluate/scripts/sweep-flags.sh "$WINNER_CFG" \
    --corpus locomo --name combined-winners-locomo \
    > "$FOLLOW_ROOT/11-combined-winners-locomo.log" 2>&1
  S11=$?; D11=$(ls -d evaluate/sweeps/combined-winners-locomo-*/ 2>/dev/null | tail -1)
else
  echo "  → skip: no chain winner config found at $WINNER_CFG" | tee -a "$MASTER"
  S11=0; D11=""
fi
record stage11 $S11 "$D11"

# ---------------------------------------------------------------------------
# Stage 12: all-flags-stacked test (LME + LoCoMo)
# ---------------------------------------------------------------------------
stage "stage12" "All-flags stacked (LME n=500)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/all-flags-stack.txt \
  --corpus lme --limit 500 --name all-flags-stack-lme \
  > "$FOLLOW_ROOT/12-all-flags-stack-lme.log" 2>&1
S12=$?; D12=$(ls -d evaluate/sweeps/all-flags-stack-lme-*/ 2>/dev/null | tail -1)
record stage12 $S12 "$D12"

stage "stage12b" "All-flags stacked (LoCoMo)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/all-flags-stack.txt \
  --corpus locomo --name all-flags-stack-locomo \
  > "$FOLLOW_ROOT/12b-all-flags-stack-locomo.log" 2>&1
S12B=$?; D12B=$(ls -d evaluate/sweeps/all-flags-stack-locomo-*/ 2>/dev/null | tail -1)
record stage12b $S12B "$D12B"

# ---------------------------------------------------------------------------
# Stage 13: LLM-judge A/B for content-sensitive flags (n=100 LME, gemini)
# ---------------------------------------------------------------------------
stage "stage13" "LLM-judge A/B — content flags (n=100 LME, gemini gen+judge)"
bash evaluate/scripts/sweep-flags-llm.sh \
  evaluate/sweeps/configs/judge-ab-content-flags.txt \
  --corpus lme --limit 100 --name judge-ab-content \
  > "$FOLLOW_ROOT/13-judge-ab-content.log" 2>&1
S13=$?; D13=$(ls -d evaluate/sweeps/judge-ab-content-*/ 2>/dev/null | tail -1)
record stage13 $S13 "$D13"

# ---------------------------------------------------------------------------
# Recap
# ---------------------------------------------------------------------------
echo "" | tee -a "$MASTER"
echo "===== FOLLOW-UP DONE — $(date +%H:%M:%S) =====" | tee -a "$MASTER"
echo "" | tee -a "$MASTER"
echo "## Sweep outputs" >> "$MASTER"
for d in "$D7" "$D8" "$D9" "$D10" "$D11" "$D12" "$D12B" "$D13"; do
  [[ -n "$d" && -f "$d/SUMMARY.md" ]] && echo "- \`$d/SUMMARY.md\`" >> "$MASTER"
done
echo "" | tee -a "$MASTER"
echo "All stages landed. Read \`$MASTER\` + per-stage SUMMARYs for triage." | tee -a "$MASTER"
