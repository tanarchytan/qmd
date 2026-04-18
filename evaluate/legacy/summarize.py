import json, sys
for t in sys.argv[1:]:
    p = f"/home/tanarchy/qmd-eval/evaluate/longmemeval/results-{t}.json"
    s = json.load(open(p))["summary"]
    print(f"{t:18s}  SR5={s['avgSR5']*100:5.1f}%  SR10={s['avgSR10']*100:5.1f}%  R5={s['avgR5']*100:5.1f}%  R10={s['avgR10']*100:5.1f}%  F1={s['avgF1']*100:5.1f}%  EM={s['avgEM']*100:5.1f}%")
