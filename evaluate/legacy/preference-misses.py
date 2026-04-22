#!/usr/bin/env python3
"""Find preference questions where qmd missed sr5 and compare against MemPalace.
Usage: preference-misses.py <qmd-results.json> <mempalace-log>"""
import json, re, sys

qmd_path, mp_log = sys.argv[1], sys.argv[2]
dataset = json.load(open("/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json"))
qid_to_item = {q["question_id"]: q for q in dataset}

mp_r5 = {}
row = re.compile(r"\[\s*\d+/\d+\]\s+(\S+)\s+R@5=(\d)")
for line in open(mp_log):
    m = row.search(line)
    if m:
        mp_r5[m.group(1)] = int(m.group(2))

d = json.load(open(qmd_path))
print("Preference questions where qmd missed sr5:")
print()
for r in d["results"]:
    if r["question_type"] != "single-session-preference":
        continue
    if r.get("sr5", 0) == 1:
        continue
    qid = r["question_id"]
    item = qid_to_item[qid]
    mp_hit = mp_r5.get(qid, "?")
    print(f"── {qid} ──")
    print(f"  question: {item['question'][:140]}")
    print(f"  answer:   {item['answer'][:140]}")
    print(f"  ground-truth session_ids: {item.get('answer_session_ids', [])}")
    print(f"  qmd sr5={r.get('sr5',0)} r5={r.get('r5',0)} mem={r.get('memoriesFound','?')}")
    print(f"  MemPalace R@5: {mp_hit}")
    pred = r.get("prediction","")[:300]
    print(f"  qmd top retrieved (truncated): {pred}")
    print()
