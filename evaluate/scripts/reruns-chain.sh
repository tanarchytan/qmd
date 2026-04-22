#!/usr/bin/env bash
# Reruns for the stages invalidated by the two rerank bugs + your kill:
#
#   main chain Stage 2  — LME reranker A/B (silent no-op, filename bug)
#   main chain Stage 4  — LoCoMo reranker A/B (silent no-op)
#   main chain Stage 6  — combined winners (auto-picked from invalid Stage 2)
#   follow-up Stage 7   — LME reranker × 7/3 weight (OOM hang, then killed)
#   follow-up Stage 8   — LoCoMo Phase 1 flag ablation (killed mid-run)
#
# Fixes already in place on dev at this point:
#   9cba9bc — rerank filename auto-resolve for non-legacy models
#   f766f9d — max_length=512 cap to prevent 67 GB ModernBERT OOM
#
# Logical order:
#   R1. LoCoMo Phase 1 flag ablation  (no-rerank, establishes validated baseline)
#   R2. LME reranker A/B              (first real reranker data)
#   R3. LoCoMo reranker A/B           (cross-corpus reranker check)
#   R4. LME reranker × 7/3 weight     (weight interaction w/ best reranker)
#   R5. Combined winners              (auto-picks the real reranker winner)
#
# ~90 min total. Runs after the current follow-up completes.

set -uo pipefail
cd "$(dirname "$0")/../.."

RERUN_ROOT="evaluate/sweeps/reruns-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RERUN_ROOT"
MASTER="$RERUN_ROOT/MASTER.md"

echo "# Reruns chain — $(date)" > "$MASTER"
echo "Replays stages 2/4/6/7/8 with fixes 9cba9bc + f766f9d applied." >> "$MASTER"
echo "Anchor log directory: \`$RERUN_ROOT\`" >> "$MASTER"

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
# R1: LoCoMo Phase 1 flag ablation (rerun of killed follow-up stage 8)
# ---------------------------------------------------------------------------
stage "R1" "LoCoMo Phase 1 flag ablation (9 flags, default weights)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-locomo.txt \
  --corpus locomo --name rerun-flag-sweep-locomo \
  > "$RERUN_ROOT/r1-flag-sweep-locomo.log" 2>&1
R1=$?; D1=$(ls -d evaluate/sweeps/rerun-flag-sweep-locomo-*/ 2>/dev/null | tail -1)
record R1 $R1 "$D1"

# ---------------------------------------------------------------------------
# R2: LME reranker A/B (rerun of main chain stage 2)
# ---------------------------------------------------------------------------
stage "R2" "LME reranker A/B — 6 candidates × n=500 (fixed filename + OOM cap)"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus lme --limit 500 --name rerun-phase3-lme \
  > "$RERUN_ROOT/r2-phase3-lme.log" 2>&1
R2=$?; D2=$(ls -d evaluate/sweeps/rerun-phase3-lme-*/ 2>/dev/null | tail -1)
record R2 $R2 "$D2"

# ---------------------------------------------------------------------------
# R3: LoCoMo reranker A/B (rerun of main chain stage 4)
# ---------------------------------------------------------------------------
stage "R3" "LoCoMo reranker A/B — 6 candidates"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus locomo --name rerun-phase3-locomo \
  > "$RERUN_ROOT/r3-phase3-locomo.log" 2>&1
R3=$?; D3=$(ls -d evaluate/sweeps/rerun-phase3-locomo-*/ 2>/dev/null | tail -1)
record R3 $R3 "$D3"

# ---------------------------------------------------------------------------
# R4: LME reranker × 7/3 weight (rerun of follow-up stage 7)
# ---------------------------------------------------------------------------
stage "R4" "LME reranker × 7/3 weight"
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-at-w73.txt \
  --corpus lme --limit 500 --name rerun-rerank-at-w73-lme \
  > "$RERUN_ROOT/r4-rerank-at-w73-lme.log" 2>&1
R4=$?; D4=$(ls -d evaluate/sweeps/rerun-rerank-at-w73-lme-*/ 2>/dev/null | tail -1)
record R4 $R4 "$D4"

# ---------------------------------------------------------------------------
# R5: Combined winners, auto-picked from R2 (rerun of main chain stage 6)
# ---------------------------------------------------------------------------
stage "R5" "Combined winners (auto-picks from R2 winner)"

BEST_RERANK=""
if [[ -n "$D2" && -f "$D2/SUMMARY.md" ]]; then
  BEST_RERANK=$(
    grep -E "^\| [a-z]" "$D2/SUMMARY.md" \
      | awk -F '|' '$5 ~ /0\.9/ {gsub(/ /, "", $2); print $2 " " $5}' \
      | sort -k2 -r \
      | head -1 \
      | awk '{print $1}'
  )
fi
echo "  → best reranker from R2: ${BEST_RERANK:-<none — using baseline>}" | tee -a "$MASTER"

COMBINED="$RERUN_ROOT/combined-winners.txt"
cat > "$COMBINED" <<EOF
baseline
expand-entities-w73     LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities
vec-min-off-w73         LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_VEC_MIN_SIM=0.0
entities-vec-min-off    LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_MEMORY_EXPAND=entities LOTL_VEC_MIN_SIM=0.0
EOF

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
  --corpus lme --limit 500 --name rerun-combined-winners \
  > "$RERUN_ROOT/r5-combined-winners.log" 2>&1
R5=$?; D5=$(ls -d evaluate/sweeps/rerun-combined-winners-*/ 2>/dev/null | tail -1)
record R5 $R5 "$D5"

# ---------------------------------------------------------------------------
# Recap
# ---------------------------------------------------------------------------
echo "" | tee -a "$MASTER"
echo "===== RERUNS DONE — $(date +%H:%M:%S) =====" | tee -a "$MASTER"
echo "" | tee -a "$MASTER"
echo "## Sweep outputs" >> "$MASTER"
for d in "$D1" "$D2" "$D3" "$D4" "$D5"; do
  [[ -n "$d" && -f "$d/SUMMARY.md" ]] && echo "- \`$d/SUMMARY.md\`" >> "$MASTER"
done
echo "" | tee -a "$MASTER"
echo "All reruns complete. Read \`$MASTER\` + per-stage SUMMARYs." | tee -a "$MASTER"
