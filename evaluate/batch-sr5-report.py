#!/usr/bin/env python3
"""Print a compact sr5 + r5 summary table for a list of LME result JSON files.
Usage: batch-sr5-report.py <file1.json> <file2.json> ..."""
import json, sys, os
from collections import defaultdict

CATEGORIES = [
    ("single-session-user", "s-user"),
    ("single-session-assistant", "s-asst"),
    ("single-session-preference", "s-pref"),
    ("knowledge-update", "kn-upd"),
    ("temporal-reasoning", "temp"),
    ("multi-session", "multi"),
]

def load(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    s = d.get("summary") or {}
    by = defaultdict(lambda: {"n":0,"r5":0,"sr5":0})
    for r in d.get("results", []):
        t = r.get("question_type","?")
        by[t]["n"] += 1
        by[t]["r5"] += r.get("r5",0)
        by[t]["sr5"] += r.get("sr5",0)
    row = {
        "name": os.path.basename(path).replace("results-","").replace(".json",""),
        "n": s.get("total", sum(v["n"] for v in by.values())),
        "r5_all": s.get("avgR5"),
        "sr5_all": s.get("avgSR5"),
    }
    for cat, short in CATEGORIES:
        v = by.get(cat)
        if v and v["n"] > 0:
            row[f"r5_{short}"] = v["r5"]/v["n"]
            row[f"sr5_{short}"] = v["sr5"]/v["n"]
        else:
            row[f"r5_{short}"] = None
            row[f"sr5_{short}"] = None
    return row

def pct(x):
    return "-" if x is None else f"{x*100:.1f}"

def main():
    rows = []
    for p in sys.argv[1:]:
        r = load(p)
        if r: rows.append(r)
    header = f"{'model':<36} {'n':>4}  {'SR5':>5} {'R5':>5}  " + "  ".join(f"{s:>6}" for _,s in CATEGORIES)
    print(header)
    print("="*len(header))
    print("SR5 (session-id — MemPalace comparable):")
    for r in rows:
        cells = "  ".join(f"{pct(r[f'sr5_{s}']):>6}" for _,s in CATEGORIES)
        print(f"{r['name']:<36} {r['n']:>4}  {pct(r['sr5_all']):>5} {'':>5}  {cells}")
    print()
    print("R5 (token-overlap — legacy):")
    for r in rows:
        cells = "  ".join(f"{pct(r[f'r5_{s}']):>6}" for _,s in CATEGORIES)
        print(f"{r['name']:<36} {r['n']:>4}  {'':>5} {pct(r['r5_all']):>5}  {cells}")

if __name__ == "__main__":
    main()
