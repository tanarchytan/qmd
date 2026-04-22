#!/usr/bin/env python3
"""Parse MemPalace bench stdout log + LME dataset, compute per-category R@5 and R@10.
Usage: mempalace-per-cat.py <bench.log> <longmemeval_s_cleaned.json>"""
import json, re, sys
from collections import defaultdict

log_path, data_path = sys.argv[1], sys.argv[2]

# Load dataset: question_id → question_type
data = json.load(open(data_path))
qid_type = {q["question_id"]: q["question_type"] for q in data}

# Parse log lines like: "  [ 480/500] 352ab8bd                       R@5=0 R@10=0  miss"
row = re.compile(r"\[\s*\d+/\d+\]\s+(\S+)\s+R@5=(\d)\s+R@10=(\d)")
by_type = defaultdict(lambda: {"n": 0, "r5": 0, "r10": 0})
overall = {"n": 0, "r5": 0, "r10": 0}

for line in open(log_path):
    m = row.search(line)
    if not m:
        continue
    qid, r5, r10 = m.group(1), int(m.group(2)), int(m.group(3))
    qtype = qid_type.get(qid, "?unknown")
    by_type[qtype]["n"] += 1
    by_type[qtype]["r5"] += r5
    by_type[qtype]["r10"] += r10
    overall["n"] += 1
    overall["r5"] += r5
    overall["r10"] += r10

print(f"{'category':<28}  {'n':>4}  {'R@5':>7}  {'R@10':>7}")
print("=" * 50)
for t in sorted(by_type):
    v = by_type[t]
    print(f"  {t:<26}  {v['n']:>4}  {v['r5']/v['n']*100:5.1f}%  {v['r10']/v['n']*100:5.1f}%")
print("=" * 50)
print(f"  {'OVERALL':<26}  {overall['n']:>4}  {overall['r5']/overall['n']*100:5.1f}%  {overall['r10']/overall['n']*100:5.1f}%")
