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

> **Repro note (2026-04-19):** the mxbai-xs row above doesn't fully reproduce
> on the current `lme-s-mxbai-n500-v17.sqlite`. Re-running the winner config
> at n=500 (5 identical passes, commit `ba4f062` + earlier, byte-identical
> across passes) produces **rAny@5 97.8% / R@5 93.4% / MRR 0.907 / NDCG@10 0.904**.
> Diff vs pinned: −0.6pp rAny@5, −0.3pp R@5, −0.010 MRR, −0.009 NDCG@10.
> Probable cause: original numbers measured on a slightly different DB state
> (the v17 DB has been reindexed since). Bisect across the 10 commits
> between the SNAPSHOTS commit (`9af176c`) and current dev showed
> identical code behavior — not a code regression.
> See `devnotes/sessions/session-2026-04-19-overnight-sweeps.md`.

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

## v1.0.0 GA — combined-winners stack (reserved, fills tonight)

> This section is a **skeleton**. Numbers below are `TBD` placeholders —
> will be filled when the combined-winners run (#38) lands after the LM
> Studio host comes back tonight. Replace TBD → actual in one pass when
> the results JSON is ready; then bump #41 → completed.

Stack (see `evaluate/scripts/phase-d-combined-winners.sh`):

- Embedder: mxbai-embed-xsmall-v1 q8 (384d)
- Retrieval: RRF 0.7/0.3 BM25/vec + keyword expansion + synonyms
- Rerank: `jinaai/jina-reranker-v1-tiny-en` (Stage 9 winner, +4.9pp R@5)
- Generator: `google/gemma-4-e4b` via LM Studio parallel=8 ctx=131072
- Judge: `google/gemma-4-26b-a4b`, schema-forced JSON, 3-run majority vote
- Prompt: v14 CoT (`LOTL_EVAL_PROMPT_RULES=v14`)
- LoCoMo judge: strict (`LOTL_EVAL_LOCOMO_JUDGE=strict`)
- Hygiene: `LOTL_RECALL_NO_TOUCH=on`

### LongMemEval n=500 — combined-winners

| Metric | Value | Wilson 95% CI | Notes |
|---|---|---|---|
| F1 (paper metric) | `TBD` | `[TBD, TBD]` | — |
| R@5 | `TBD` | `[TBD, TBD]` | retrieval @ k=5 |
| MRR | `TBD` | — | — |
| NDCG@10 | `TBD` | — | — |
| Judge accuracy (3-run majority) | `TBD` | `[TBD, TBD]` | — |
| Wall | `TBD` min | — | gemma-e4b parallel=8 |

### LoCoMo 10-conv × 20q (n=200) — combined-winners

| Metric | Value | Wilson 95% CI |
|---|---|---|
| R@5 | `TBD` | `[TBD, TBD]` |
| MRR | `TBD` | — |
| F1 | `TBD` | `[TBD, TBD]` |
| Judge accuracy (strict, 3-run majority) | `TBD` | `[TBD, TBD]` |
| Wall | `TBD` min | — |

### Adversarial baseline (#36) — judge leniency check

| Answer source | Judge "correct" rate | Expected | Verdict |
|---|---|---|---|
| Golden                  | `TBD` | ≥60% | — |
| v1 specific-wrong       | `TBD` | <10% | — |
| v2 vague-topical        | `TBD` | <5%  | — |

If v1 acceptance is much above 10% or v2 above 5%, the judge is too lenient
for the release claim — retune gate before calling the release.

### BEIR top-3 GGUF rerank sweep (#53) — optional alternative default

Measured via LM Studio `/v1/chat/completions` scoring shim (see
`src/llm/lmstudio-rerank.ts`). Kept out of the default stack if any config
regresses vs jina-tiny; may be promoted post-release.

| Reranker | BEIR paper | LoCoMo R@5 (7/3 weights) | Δ vs jina-tiny | Wall/q |
|---|---|---|---|---|
| jina-tiny-v1 (default)    | —      | `TBD` | —     | ~4 s (ONNX baseline) |
| jina-reranker-v3          | 61.94  | `TBD` | `TBD` | `TBD` |
| mxbai-rerank-large-v2     | 61.44  | `TBD` | `TBD` | `TBD` |
| Qwen3-Reranker-4B         | 61.16  | `TBD` | `TBD` | `TBD` |
| bge-reranker-v2-m3        | 56.51  | `TBD` | `TBD` | `TBD` |

Reproducer (tonight):
```sh
bash evaluate/scripts/phase-d-combined-winners.sh --dry-run   # verify env stack
bash evaluate/scripts/phase-d-combined-winners.sh             # fire full run
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/rerank-lmstudio-gguf.txt \
  --corpus locomo --name beir-top3-gguf
node evaluate/scripts/adversarial-gen.mjs \
  evaluate/longmemeval/results-phase-d-combined-winners-pass1.json \
  --provider lmstudio --limit 100
```

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
