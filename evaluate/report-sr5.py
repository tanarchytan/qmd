#!/usr/bin/env python3
import json, sys
from collections import defaultdict
d = json.load(open(sys.argv[1]))
s = d["summary"]
print(f"OVERALL  R@5={s['avgR5']*100:.1f}%  SR@5={s['avgSR5']*100:.1f}%  SR@10={s['avgSR10']*100:.1f}%")
by = defaultdict(lambda: {"n":0,"r5":0,"sr5":0})
for r in d["results"]:
    t = r["question_type"]
    by[t]["n"] += 1
    by[t]["r5"] += r["r5"]
    by[t]["sr5"] += r["sr5"]
print()
print(f"  {'category':26s}    n   r5(token)  sr5(session)")
for t in sorted(by):
    v = by[t]
    n = v["n"]
    print(f"  {t:26s}  {n:3d}    {v['r5']/n*100:5.1f}%     {v['sr5']/n*100:5.1f}%")
