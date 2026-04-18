#!/usr/bin/env python3
"""
Parse MemPalace locomo_bench / longmemeval_bench result JSONs into a
compact table so we can paste them next to the QMD v15.1 / v16 numbers.

Usage:
    python3 evaluate/summarize-mempalace.py
"""
import json, os, sys
from pathlib import Path

RESULTS_DIR = Path.home() / "external" / "mempalace-results"

def load_json(name):
    p = RESULTS_DIR / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception as e:
        print(f"  failed to parse {p.name}: {e}", file=sys.stderr)
        return None

def load_jsonl(name):
    p = RESULTS_DIR / name
    if not p.exists():
        return None
    try:
        return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    except Exception as e:
        print(f"  failed to parse {p.name}: {e}", file=sys.stderr)
        return None

def summarize_locomo(data, label):
    if data is None:
        print(f"{label}: missing")
        return
    # Schema varies — locomo_bench writes {summary, results}
    summary = data.get("summary") if isinstance(data, dict) else None
    results = data.get("results") if isinstance(data, dict) else data
    if summary:
        print(f"\n=== {label} ===")
        for k, v in summary.items():
            if isinstance(v, float):
                print(f"  {k:20s}: {v*100:6.1f}%" if v <= 1 else f"  {k:20s}: {v:.3f}")
            else:
                print(f"  {k:20s}: {v}")
    elif results:
        n = len(results)
        print(f"\n=== {label} (derived from {n} results) ===")
        # try common field names
        for key in ["recall_at_5", "recall_at_10", "recall_any", "recall"]:
            if results and key in results[0]:
                avg = sum(r.get(key, 0) for r in results) / n
                print(f"  {key:20s}: {avg*100:6.1f}%")

def summarize_lme(data, label):
    if data is None:
        print(f"{label}: missing")
        return
    n = len(data)
    print(f"\n=== {label} (n={n}) ===")
    if n == 0:
        return
    keys = [k for k in data[0].keys() if k.startswith("recall") or k == "ndcg" or "rank" in k.lower()]
    for k in keys:
        vals = [r.get(k, 0) for r in data if isinstance(r.get(k), (int, float))]
        if vals:
            avg = sum(vals) / len(vals)
            print(f"  {k:20s}: {avg*100:6.1f}%" if avg <= 1 else f"  {k:20s}: {avg:.3f}")

if __name__ == "__main__":
    print(f"Reading from: {RESULTS_DIR}")
    if not RESULTS_DIR.exists():
        print(f"  (dir does not exist — run run-mempalace-baseline.sh first)")
        sys.exit(1)

    summarize_locomo(load_json("mp-locomo-session.json"), "MemPalace LoCoMo (session granularity)")
    summarize_locomo(load_json("mp-locomo-dialog.json"),  "MemPalace LoCoMo (dialog granularity)")
    summarize_lme(load_jsonl("mp-lme-oracle200.jsonl"),   "MemPalace LME oracle n=200 (raw, session)")
