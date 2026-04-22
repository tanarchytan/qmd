#!/usr/bin/env bash
# Chained overnight sweep pipeline. Runs ~4-5 h, logs everything, keeps
# going if an individual stage fails so the next stage still gets its turn.
#
# Stages:
#   1. Reranker probe           — validate all 6 models load + discriminate
#   2. Phase 3 LME reranker A/B — 6 candidates × n=500
#   3. LoCoMo flag × weight     — 19 configs (flags × {9/1, 1/9})
#   4. Phase 3 LoCoMo reranker  — 6 candidates × LoCoMo full
#   5. MRR drift 5-pass repro   — is 0.908 deterministic?
#   6. Combined winners sweep   — stack top signals from 2-5
#
# Output: evaluate/sweeps/chain-<timestamp>/<stage>/
# Summary rolled into evaluate/sweeps/chain-<timestamp>/MASTER.md.

set -uo pipefail
cd "$(dirname "$0")/../.."

CHAIN_ROOT="evaluate/sweeps/chain-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$CHAIN_ROOT"
MASTER="$CHAIN_ROOT/MASTER.md"

echo "# Chained sweep run — $(date)" > "$MASTER"
echo "Anchor log directory: \`$CHAIN_ROOT\`" >> "$MASTER"
echo "" >> "$MASTER"

stage() {
  local tag=$1 label=$2
  echo "" | tee -a "$MASTER"
  echo "===== [$tag] $label — $(date +%H:%M:%S) =====" | tee -a "$MASTER"
}

record_stage_outcome() {
  local tag=$1 exit=$2 sweep_dir=${3:-}
  if [[ $exit -eq 0 ]]; then
    echo "  → OK (exit 0)" | tee -a "$MASTER"
    [[ -n "$sweep_dir" && -f "$sweep_dir/SUMMARY.md" ]] && echo "  → Summary: \`$sweep_dir/SUMMARY.md\`" | tee -a "$MASTER"
  else
    echo "  → FAILED (exit $exit) — chain continues" | tee -a "$MASTER"
  fi
}

# ---------------------------------------------------------------------------
# Stage 1: reranker probe
# ---------------------------------------------------------------------------
stage "stage1" "Reranker probe (6 candidates)"
npx tsx evaluate/scripts/probe-rerankers.mts > "$CHAIN_ROOT/01-probe.log" 2>&1
record_stage_outcome stage1 $? "$CHAIN_ROOT"

# ---------------------------------------------------------------------------
# Stage 2: Phase 3 LME reranker A/B
# ---------------------------------------------------------------------------
stage "stage2" "LME reranker A/B — 6 candidates × n=500"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus lme --limit 500 --name phase3-lme \
  > "$CHAIN_ROOT/02-phase3-lme.log" 2>&1
STAGE2_EXIT=$?
STAGE2_DIR=$(ls -d evaluate/sweeps/phase3-lme-*/ 2>/dev/null | tail -1)
record_stage_outcome stage2 $STAGE2_EXIT "$STAGE2_DIR"

# ---------------------------------------------------------------------------
# Stage 3: LoCoMo flag × weight
# ---------------------------------------------------------------------------
stage "stage3" "LoCoMo flag × weight — 19 configs"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-x-weight-locomo.txt \
  --corpus locomo --name flag-x-weight-locomo \
  > "$CHAIN_ROOT/03-locomo-flag-x-weight.log" 2>&1
STAGE3_EXIT=$?
STAGE3_DIR=$(ls -d evaluate/sweeps/flag-x-weight-locomo-*/ 2>/dev/null | tail -1)
record_stage_outcome stage3 $STAGE3_EXIT "$STAGE3_DIR"

# ---------------------------------------------------------------------------
# Stage 4: Phase 3 LoCoMo reranker A/B
# ---------------------------------------------------------------------------
stage "stage4" "LoCoMo reranker A/B — 6 candidates"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus locomo --name phase3-locomo \
  > "$CHAIN_ROOT/04-phase3-locomo.log" 2>&1
STAGE4_EXIT=$?
STAGE4_DIR=$(ls -d evaluate/sweeps/phase3-locomo-*/ 2>/dev/null | tail -1)
record_stage_outcome stage4 $STAGE4_EXIT "$STAGE4_DIR"

# ---------------------------------------------------------------------------
# Stage 5: MRR drift 5-pass repro
# ---------------------------------------------------------------------------
stage "stage5" "MRR drift — 5 identical baseline passes"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/mrr-drift-5-passes.txt \
  --corpus lme --limit 500 --name mrr-drift \
  > "$CHAIN_ROOT/05-mrr-drift.log" 2>&1
STAGE5_EXIT=$?
STAGE5_DIR=$(ls -d evaluate/sweeps/mrr-drift-*/ 2>/dev/null | tail -1)
record_stage_outcome stage5 $STAGE5_EXIT "$STAGE5_DIR"

# ---------------------------------------------------------------------------
# Stage 6: combined winners — built dynamically from Stage 2 winner.
# Falls back to a reasonable default stack if the parse fails.
# ---------------------------------------------------------------------------
stage "stage6" "Combined winners sweep"

# Identify the best reranker from Stage 2 (highest MRR beating baseline)
BEST_RERANK=""
if [[ -n "$STAGE2_DIR" && -f "$STAGE2_DIR/SUMMARY.md" ]]; then
  BEST_RERANK=$(
    grep -E "^\| [a-z]" "$STAGE2_DIR/SUMMARY.md" \
      | awk -F '|' '$5 ~ /0\.9/ {gsub(/ /, "", $2); print $2 " " $5}' \
      | sort -k2 -r \
      | head -1 \
      | awk '{print $1}'
  )
fi
echo "  → best reranker: ${BEST_RERANK:-<none — using baseline>}" | tee -a "$MASTER"

COMBINED="$CHAIN_ROOT/combined-winners.txt"
cat > "$COMBINED" <<EOF
baseline
expand-entities-w73     LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities
vec-min-off-w73         LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_VEC_MIN_SIM=0.0
entities-vec-min-off    LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities LOTL_VEC_MIN_SIM=0.0
EOF

# If we found a best reranker, append it to each of the three non-baseline rows
if [[ -n "$BEST_RERANK" ]]; then
  RERANK_ID=$(awk -v t="$BEST_RERANK" '$1==t {for (i=2;i<=NF;i++) if ($i ~ /LOTL_TRANSFORMERS_RERANK_MODEL=/) {sub(/.*=/,"",$i); print $i; exit}}' evaluate/sweeps/configs/reranker-sweep-phase3.txt)
  if [[ -n "$RERANK_ID" ]]; then
    echo "  → appending $RERANK_ID to winner stack" | tee -a "$MASTER"
    cat > "$COMBINED" <<EOF
baseline
expand-entities-w73+rr  LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities LOTL_MEMORY_RERANK=on LOTL_RERANK_BACKEND=transformers LOTL_TRANSFORMERS_RERANK_MODEL=$RERANK_ID
vec-min-off-w73+rr      LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_VEC_MIN_SIM=0.0 LOTL_MEMORY_RERANK=on LOTL_RERANK_BACKEND=transformers LOTL_TRANSFORMERS_RERANK_MODEL=$RERANK_ID
entities-vec-min-off+rr LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities LOTL_VEC_MIN_SIM=0.0 LOTL_MEMORY_RERANK=on LOTL_RERANK_BACKEND=transformers LOTL_TRANSFORMERS_RERANK_MODEL=$RERANK_ID
rr-only                 LOTL_MEMORY_RERANK=on LOTL_RERANK_BACKEND=transformers LOTL_TRANSFORMERS_RERANK_MODEL=$RERANK_ID
EOF
  fi
fi

bash evaluate/scripts/sweep-flags.sh "$COMBINED" \
  --corpus lme --limit 500 --name combined-winners \
  > "$CHAIN_ROOT/06-combined-winners.log" 2>&1
STAGE6_EXIT=$?
STAGE6_DIR=$(ls -d evaluate/sweeps/combined-winners-*/ 2>/dev/null | tail -1)
record_stage_outcome stage6 $STAGE6_EXIT "$STAGE6_DIR"

# ---------------------------------------------------------------------------
# Final recap
# ---------------------------------------------------------------------------
echo "" | tee -a "$MASTER"
echo "===== CHAIN DONE — $(date +%H:%M:%S) =====" | tee -a "$MASTER"
echo "" | tee -a "$MASTER"
echo "## Sweep outputs" >> "$MASTER"
for d in "$STAGE2_DIR" "$STAGE3_DIR" "$STAGE4_DIR" "$STAGE5_DIR" "$STAGE6_DIR"; do
  [[ -n "$d" && -f "$d/SUMMARY.md" ]] && echo "- \`$d/SUMMARY.md\`" >> "$MASTER"
done
echo "" | tee -a "$MASTER"
echo "Next action: read \`$MASTER\` + each per-stage SUMMARY.md, then decide Phase 4 graduation." | tee -a "$MASTER"
