#!/usr/bin/env bash
cd ~/qmd-eval/baselines || exit 1
for r in mem0 letta mempalace hindsight; do
  echo "=== $r ==="
  ls "$r" 2>&1 | head -20
  echo "---README---"
  for cand in README.md readme.md README.rst README; do
    if [ -f "$r/$cand" ]; then
      head -30 "$r/$cand"
      break
    fi
  done
  echo "---LME refs---"
  grep -ri "longmemeval\|LongMemEval\|long_mem_eval" "$r" --include="*.md" --include="*.py" --include="*.ts" -l 2>/dev/null | head -5
  echo
done
