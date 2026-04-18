#!/usr/bin/env python3
import json, sys
from collections import defaultdict
d = json.load(open(sys.argv[1]))
s = d["summary"]
print(f"R@5={s['avgR5']*100:.1f}%  R@10={s['avgR10']*100:.1f}%  MRR={s['avgMRR']:.3f}  n={s['total']}")
by = defaultdict(lambda: {"n":0,"r5":0,"r10":0})
for r in d["results"]:
    t = r["question_type"]; by[t]["n"] += 1; by[t]["r5"] += r["r5"]; by[t]["r10"] += r["r10"]
for t in sorted(by):
    v = by[t]
    print(f"  {t:26s}  n={v['n']:3d}  R@5={v['r5']/v['n']*100:5.1f}%  R@10={v['r10']/v['n']*100:5.1f}%")
