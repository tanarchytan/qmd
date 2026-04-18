# Eval Snapshots — v1 release reference metrics

Pinned canonical results for Lotl v1. Every metric below is reproducible with
the exact env vars + script paths shown. **All numbers measured on Ryzen 7 PRO
7840U, Windows 10 IoT, Node v22.x, mxbai-xs q8 default config.**

> Re-running these is the way to verify Lotl's claims yourself. The eval harness
> is **not** part of the npm package — it lives in `evaluate/` and is run from
> source. Datasets must be downloaded separately (see per-eval README).

---

## LongMemEval (LME)

Dataset: [longmemeval_s.json](https://github.com/xiaowu0162/longmemeval) (n=500, ~47 sessions/Q).

Reproduce: see [`longmemeval/README.md`](./longmemeval/README.md).

### n=500 embedder sweep (no-LLM, retrieval-only) — 2026-04-18

Reproducer: `bash evaluate/scripts/sweep-n500-embedders.sh`

| Embedder | Dim | rAny@5 | R@5 | R@10 | MRR | NDCG@10 | Pref MRR | Wall |
|---|---|---|---|---|---|---|---|---|
| **mxbai-embed-xsmall-v1 q8** (winner / default) | 384 | **98.4%** | 93.7% | 96.4% | 0.917 | 0.913 | **0.745** | 26 min |
| Xenova/UAE-Large-V1 | 1024 | 98.0% | 93.8% | 97.5% | **0.921** | **0.919** | 0.714 | 145 min |
| Xenova/gte-small | 384 | 97.8% | 93.2% | 97.2% | 0.919 | 0.914 | 0.703 | 26 min |
| Xenova/bge-large-en-v1.5 | 1024 | 98.0% | 93.6% | 97.5% | 0.917 | 0.917 | 0.680 | 147 min |
| jinaai/jina-v5-nano-retrieval (direct-ORT, max_len=1024) | 768 | 95.4% | 89.6% | 92.8% | 0.860 | 0.849 | 0.533 | ~5 h |

Conclusion: **mxbai-xs stays default**. All 4 challengers tied or regressed on preference MRR — the metric that tracks Lotl's real workload (memory recall about a specific user).

### Full LME with LLM judge — 2026-04-18

Generator: gemini-2.5-flash. Judge: gemini-2.5-flash. (Poe gpt-4o run hit quota at q55, partial result.)

Reproducer:
```sh
GOOGLE_API_KEY=AIza... \
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 500 --workers 2 \
    --llm gemini --judge gemini \
    --tag winner-gemini-judge --db-suffix mxbai-n500-v17
```

| Metric | Value | Notes |
|---|---|---|
| rAny@5 | 97.6% | Retrieval — same as no-LLM baseline |
| MRR | 0.919 | Retrieval |
| F1 | 14.0% | Token-overlap of generated answer vs gold |
| **Judge-Acc** | **29.7%** (n=499) | **Generator-bound** — Gemini-flash hedges instead of committing |
| — Poe gpt-4o-mini gen + gpt-4o judge (n=134 before quota) | **47.0%** | Better generator → +17pp |
| — gpt-4o gen + judge (Phase 7.1b, n=100) | **64.0%** | LongMemEval paper baseline |

### Diagnostic: where the score gap comes from

86% of LME questions retrieve the correct session in top-5. Of those, **67.7% fail at the LLM step** (Gemini-flash refuses or hedges instead of committing to the retrieved fact). This is a generator-quality issue, not a retrieval issue. See full analysis in CHANGELOG.

---

## LoCoMo

Dataset: [locomo10.json](https://github.com/snap-research/locomo) (10 multi-session conversations, ~1986 QA total).

Reproduce: see [`locomo/README.md`](./locomo/README.md). Honest-harness rationale in [`locomo/HYBRID_HARNESS.md`](./locomo/HYBRID_HARNESS.md).

### Full 10 convs (no-LLM, retrieval-only)

Reproducer: `bash evaluate/scripts/sweep-locomo-full.sh`

| Metric | Value |
|---|---|
| R@5 | 67.6% |
| R@10 | 70.9% |
| MRR | 0.593 |

### conv-26 + conv-30 vs top-3 embedders (no-LLM)

Reproducer: `bash evaluate/scripts/sweep-locomo-convs.sh`

| Model | conv-26 R@5 | conv-26 R@10 | conv-30 R@5 | conv-30 R@10 |
|---|---|---|---|---|
| baseline (mxbai-xs) | 68.8% | 73.4% | 70.5% | 73.3% |
| gte-small | **69.3%** | 73.4% | **71.4%** | 73.3% |
| uae-large | 68.8% | 72.9% | 70.5% | 73.3% |

Top-3 within 0.5-1pp on retrieval.

### Full 10 convs with LLM judge — 2026-04-18

Generator + Judge: gemini-2.5-flash.

Reproducer:
```sh
GOOGLE_API_KEY=AIza... \
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
  npx tsx evaluate/locomo/eval.mts \
    --llm gemini --judge gemini \
    --tag winner-gemini-judge --db-suffix baseline-full
```

| Metric | Value |
|---|---|
| R@5 | 67.6% |
| R@10 | 70.9% |
| MRR | 0.593 |
| F1 | 66.2% |
| EM | 41.6% |
| **Judge-Acc** | **81.4%** (n=1986) |

Per-conv F1: 60-70% range. Higher than LME because LoCoMo memories are shorter + more factual; gemini-flash extracts directly without the "you haven't mentioned" failure mode that hurts LME.

Comparison to published claims (different methodologies — not strictly apples-to-apples):
- Mem0 LoCoMo claim: 91.6% (GPT-4 class)
- Hindsight LoCoMo: 89.6% (top backbone) / 83.6% (20B backbone)
- **Lotl LoCoMo with gemini-2.5-flash**: **81.4%**

---

## Honest-eval principles applied

See [`locomo/HYBRID_HARNESS.md`](./locomo/HYBRID_HARNESS.md) for the full audit
of competitor methodologies (snap-research canonical, Mem0, Zep, Hindsight,
MemPalace, memory-lancedb-pro). Key choices in Lotl's harness:

1. **top_k=10 for LLM context** (Mem0 paper default) — avoids MemPalace's
   admitted top-50 cheat where the whole conversation leaks into the prompt.
2. **Retrieval pool = 50 but LLM context = 10** — rank metrics measured against
   the wider pool for robustness; LLM sees the same 10 memories that any other
   honest system would.
3. **Judge prompt** = Lotl-strict (`{correct: bool, reason}`). Mem0/Zep "generous
   on topic" judge prompts can be enabled later via a `--judge-style` flag
   (currently Lotl-strict only).
4. **Judge robustness** — Gemini sometimes returns prose without JSON; parser
   accepts both `{correct: true|false}` JSON and bare `CORRECT`/`WRONG` text.

---

## Sweep DBs retained for verification

After the v1 release cleanup, only the 5 candidate sweep DBs are retained on
disk (~12 GB total, down from ~83 GB):

| DB | Size | Purpose |
|---|---|---|
| `evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite` | 1.6 GB | Winner baseline (mxbai-xs 384d) |
| `evaluate/longmemeval/dbs/lme-s-gte-small-n500.sqlite` | 1.6 GB | Challenger (gte-small 384d) |
| `evaluate/longmemeval/dbs/lme-s-bge-large-n500.sqlite` | 2.9 GB | Challenger (bge-large 1024d) |
| `evaluate/longmemeval/dbs/lme-s-uae-large-n500.sqlite` | 2.9 GB | Challenger (UAE-Large 1024d) |
| `evaluate/longmemeval/dbs/lme-s-jina-v5-nano-n500.sqlite` | 2.4 GB | Challenger (jina-v5 768d, direct-ORT) |
| `evaluate/locomo/dbs/conv-*-baseline-full.sqlite` (10 files) | ~10 MB | LoCoMo per-conv winner DBs |

Pre-ingested DBs make `--judge` re-runs ~10x faster (skip ingest, just recall +
gen + judge). They are not part of the npm package — only checked into local
working copy for benchmark reproducibility.

---

## Verifying yourself

```sh
# 1. Install + build
npm install && npm run build

# 2. Run the vitest suite (validates SDK behavior, no API needed)
npx vitest run test/

# 3. Choose any of the snapshot reproducers above and run it.
#    All scripts are in evaluate/scripts/ and use --db-suffix to reuse cached ingest.
```

If your numbers diverge by more than ±1pp on retrieval metrics, please open an
issue with your env (Node version, OS, `LOTL_EMBED_*` env vars).
