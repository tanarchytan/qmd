#!/usr/bin/env bash
# Compare mem counts and metrics across a night A/B batch.
dir="$1"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "usage: $0 <log-dir>"; exit 1
fi
for f in "$dir"/*.log; do
  tag=$(basename "$f" .log)
  avg=$(grep -oE 'mem=[0-9]+' "$f" | awk -F= 'BEGIN{s=0;c=0} {s+=$2; c++} END{if(c){printf "%.1f",s/c}else{print "-"}}')
  r5=$(grep -oE 'R@5:[[:space:]]+[0-9.]+%' "$f" | head -1)
  multi=$(grep -oE 'multi-session[^R]*R@5=[[:space:]]*[0-9]+%' "$f" | head -1)
  mrr=$(grep -oE 'MRR:[[:space:]]+[0-9.]+' "$f" | head -1)
  echo "$tag | avg_mem=$avg | $r5 | $mrr | $multi"
done
