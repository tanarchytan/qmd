#!/usr/bin/env bash
# Git bisect helper for the SNAPSHOTS.md 0.917 → current 0.908 MRR drift.
#
# Runs a fast LME n=100 baseline at each bisect step. Writes the MRR to
# /tmp/bisect-mrr.txt. A step is "good" if MRR ≥ 0.915, "bad" if MRR ≤ 0.910.
#
# Assumes git-bisect is already set up. Run as:
#   git bisect start
#   git bisect good <SNAPSHOTS-commit>    # where MRR was 0.917
#   git bisect bad HEAD                    # where MRR is 0.908
#   git bisect run evaluate/scripts/mrr-drift-bisect.sh
#
# Note: needs the pre-populated v17 DB — don't checkout commits that predate
# the DB schema. If bisect lands on a migration commit, inspect manually.

set -e
cd "$(dirname "$0")/../.."

TAG="bisect-$(git rev-parse --short HEAD)"
LOG="/tmp/mrr-drift-bisect-$TAG.log"
echo "=== bisect step: $(git log -1 --oneline) ===" | tee -a /tmp/bisect-mrr.txt

# Run with minimal perturbation: same env as Phase 1 baseline, n=100 is ~25s.
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_TRANSFORMERS_DTYPE=q8 \
LOTL_EMBED_MAX_WORKERS=4 \
LOTL_EMBED_MICROBATCH=32 \
OMP_NUM_THREADS=4 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 100 --workers 4 \
    --db-suffix mxbai-n500-v17 \
    --tag "$TAG" --no-llm > "$LOG" 2>&1

# Extract MRR from results JSON
RESULTS="evaluate/longmemeval/results-$TAG.json"
if [[ ! -f "$RESULTS" ]]; then
  echo "  → no results file — treat as skip" | tee -a /tmp/bisect-mrr.txt
  exit 125   # git-bisect skip code
fi

MRR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RESULTS', 'utf8')).summary.avgMRR ?? 'NaN')")
echo "  → MRR=$MRR" | tee -a /tmp/bisect-mrr.txt

# Decision: good (≥0.915) / bad (≤0.910) / skip (between, too close to call)
if awk "BEGIN{exit !($MRR >= 0.915)}"; then
  echo "  → GOOD" | tee -a /tmp/bisect-mrr.txt
  exit 0
elif awk "BEGIN{exit !($MRR <= 0.910)}"; then
  echo "  → BAD" | tee -a /tmp/bisect-mrr.txt
  exit 1
else
  echo "  → SKIP (MRR between 0.910 and 0.915)" | tee -a /tmp/bisect-mrr.txt
  exit 125
fi
