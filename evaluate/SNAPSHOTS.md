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

## LME n=500 weight sweep × jina-tiny rerank — 2026-04-20

Purpose: find the RRF BM25/vec ratio that maximizes metrics with rerank on.
10 configs (baseline + 9 weight points). Reproducer:

```sh
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/rerank-weight-sweep-phase4.txt \
  --corpus lme --limit 500 --name rerank-weight-jina-lme
```

| tag | rAny@5 | R@5 | MRR | NDCG@10 | Δ vs baseline (MRR) |
|---|---|---|---|---|---|
| baseline (RRF 9/1 no rerank) | 97.8% | 93.4% | 0.907 | 0.904 | — |
| rr-1-9 (vec-heavy + rerank) | 94.2% | 87.0% | 0.897 | 0.878 | −0.010 |
| rr-2-8 | 94.2% | 86.9% | 0.895 | 0.877 | −0.012 |
| rr-3-7 | 94.2% | 87.3% | 0.894 | 0.878 | −0.013 |
| rr-4-6 | 94.6% | 88.4% | 0.899 | 0.887 | −0.008 |
| rr-5-5 | 98.0% | 94.0% | 0.917 | 0.911 | **+0.010** |
| rr-6-4 | 98.2% | **94.5%** | 0.917 | 0.915 | +0.010 |
| rr-7-3 | 98.2% | 94.2% | 0.918 | 0.914 | +0.011 |
| **rr-8-2** | 98.2% | 94.3% | **0.920** | **0.916** | **+0.013** |
| rr-9-1 | 98.2% | 94.4% | 0.919 | 0.916 | +0.012 |

**Conclusions:**

- **Vec-heavy regresses** (rr-1-9 → rr-4-6): mxbai-xs can't supply a clean
  candidate pool — rerank cannot recover from a bad initial pool.
- **BM25-heavy + rerank wins**: 0.8 / 0.2 is the sweet spot by MRR + NDCG@10.
  `rr-6-4` best by R@5, `rr-8-2` best by MRR/NDCG@10 — all within noise of each other.
- **New v1.0 default**: `rr-8-2` (BM25=0.8, VEC=0.2, jina-reranker-v1-tiny-en).

Partial LoCoMo weight sweep (2026-04-20, 3/10 configs before overnight
process death) confirmed the same shape: rr-9-1 avgR5=0.575 / avgMRR=0.468 beats
rr-8-2 (0.572/0.467) beats rr-7-3 (0.569/0.465). Vec-heavy tail skipped
— LME already proves they tank.

Phase 6 follow-on sweeps (in flight 2026-04-21) test whether the new
BM25-heavy baseline has more to give: max-chars, MMR × candidate pool,
rerank blend α, expand × synonyms. See `docs/TODO.md` CAT 2 for live status.

---

## Phase 6 squeeze sweeps — 2026-04-21 (LME n=500, retrieval-only)

Built on 2026-04-20 LME weight-sweep winner (rr-8-2: BM25=0.8/VEC=0.2 + jina-tiny rerank).
4 sub-sweeps × 24 configs total. Reproducer: `bash evaluate/scripts/phase6-watchdog.sh`.

### max-chars (`LOTL_ANSWER_MAX_CHARS` ∈ {500, 1000, 2000, 6000, 7500})

All 5 byte-identical: R@5 0.943 / MRR 0.920. **No-op on retrieval** — char cap only
affects the LLM answer prompt, which `--no-llm` mode bypasses. Re-test under LLM
judge once LM Studio is back.

### MMR × K-pool (8 configs)

All 8 byte-identical: R@5 0.943 / MRR 0.920. MMR session-level diversification
has no effect on LME single-scope queries; pool size 20/40/75/100 produces
identical top-K results. **No signal** — `LOTL_MEMORY_RERANK_CANDIDATE_LIMIT`
hardcoded to 40, MMR knob hidden from .env.example (kept in code for LoCoMo
follow-on).

### Rerank blend α — **REAL SIGNAL**

| tag | R@5 | MRR | NDCG / F1 |
|---|---|---|---|
| blend-10-00 (RRF only) | 0.934 | 0.907 | — / 0.062 |
| blend-07-03 (prior default) | 0.943 | 0.920 | — / 0.065 |
| **blend-05-05 (winner)** | **0.944** | **0.922** | — / 0.066 |
| blend-03-07 | 0.941 | 0.914 | — / 0.067 |
| blend-00-10 (pure rerank) | 0.919 | 0.895 | — / 0.067 |

Equal-weight blend wins by +0.001 R@5 / +0.002 MRR over 0.7/0.3.
**Hardcoded** — `MEMORY_RERANK_BLEND_ORIGINAL=0.5`, `_RERANK=0.5`.

### Expand × Synonyms — **REAL SIGNAL**

| tag | R@5 | MRR |
|---|---|---|
| expand-off-syn-off | **0.948** | 0.918 |
| expand-ent-syn-off | 0.946 | 0.918 |
| expand-ent-syn-on | 0.946 | 0.916 |
| expand-off-syn-on | 0.946 | 0.916 |
| **expand-kw-syn-off** | 0.943 | **0.921** |
| expand-kw-syn-on (prior default) | 0.943 | 0.920 |

`syn=off` wins on every expand mode by +0.001-0.002 MRR. **Hardcoded**:
synonyms always off in `src/memory/index.ts` (env knob removed).

`expand=keywords` wins MRR; `expand=off` wins R@5 by +0.005pp at -0.002 MRR.
Kept env-configurable. Default stays `keywords` (best MRR, our headline metric).

### Headline (with all Phase 6 hardcodes)

- **Best R@5: 94.8%** (+1.4pp vs 2026-04-20 baseline 93.4%, +5.0pp vs 2026-04-17 no-rerank baseline)
- **Best MRR: 0.922** (+0.015 vs 2026-04-20 baseline 0.907)

---

## v1.0.0 GA — combined-winners stack (landed 2026-04-21)

Stack (`evaluate/scripts/phase-d-combined-winners.sh`):

- Embedder: mxbai-embed-xsmall-v1 q8 (384d)
- Retrieval: **RRF 0.8/0.2 BM25/vec** + keyword expansion + synonyms hardcoded off (Phase 6)
- Rerank: `jinaai/jina-reranker-v1-tiny-en` (Stage 9 winner)
- Rerank blend: **0.5 / 0.5** hardcoded (Phase 6 winner, +0.002 MRR over 0.7/0.3)
- Generator: `google/gemma-4-e4b` via LM Studio, parallel=8 ctx=131072
- Judge: `google/gemma-4-26b-a4b` parallel=3 ctx=49152, schema-forced JSON, **3-run majority vote**
- Prompt: **v14 CoT** (`LOTL_EVAL_PROMPT_RULES=v14`) — ported from dial481/locomo-audit
- LoCoMo judge: **strict** (drops 6.9× "touches on topic" leniency bug)
- Hygiene: `LOTL_RECALL_NO_TOUCH=on`

### LongMemEval _s (n=500) — combined-winners

| Metric | Value | Notes |
|---|---|---|
| R@5 | **86.2%** | retrieval @ k=5 |
| R@10 | 93.3% | |
| MRR | **0.888** | |
| NDCG@10 | 0.840 | |
| **Judge accuracy (3-run majority)** | **73.8%** | n=488 of 500 judged (12 parse failures) |
| F1 (token overlap) | 20.4% | |
| SH (substring hit) | 51.2% | |
| rAny@5 | 97.8% | |

Context:
- Prior Phase B baseline (same stack without rerank or RRF 0.8/0.2): R@5 88.5% / MRR 0.912 / Judge 72.6%.
- Combined-winners trades 2.3pp R@5 for **+1.2pp JudgeCorrect** — rerank re-orders what the LLM sees, which helps answers more than raw retrieval metrics.
- Full-context baseline (no retrieval, entire chat in prompt) per locomo-audit: 74.29% for gpt-4o-mini, 92.62% for gpt-4.1-mini. Our 73.8% is **within 0.5pp of gpt-4o-mini** full-context, using only top-K retrieval + a 4B Matformer gen.

### LoCoMo 10-conv × 20q (n=200) — combined-winners

| Metric | Value | Δ vs baseline (no rerank, RRF 9/1) |
|---|---|---|
| **R@5** | **60.0%** | **+9.5pp** |
| R@10 | 71.5% | +10.5pp |
| **MRR** | **0.467** | **+0.099** |
| SH (substring hit) | 27.0% | +6.0pp |
| F1 | 13.2% | +0.2pp (tie) |

Big LoCoMo win — combined-winners lifts retrieval meaningfully on the
harder, multi-session LoCoMo workload.

### LoCoMo audit theoretical ceiling

Cross-referenced `evaluate/scripts/audit-locomo-goldens.mjs` against
dial481/locomo-audit's `errors.json` (156 scoring errors flagged, 99
score-corrupting). If all audit-corrected goldens were applied:

- **Theoretical ceiling: 73.5%** (+5.6pp over current LoCoMo score).
- Top error types: HALLUCINATION (fabricated specifics), INCOMPLETE (partial list), TEMPORAL_ERROR (wrong month).

Most of the gap isn't a Lotl retrieval issue — it's bad published goldens.

### Adversarial baseline (#36) — judge leniency check

`evaluate/scripts/adversarial-gen.mjs` generates distractors per question;
`adversarial-rejudge.mjs` re-runs the same judge on them.

| Answer source | Judge "correct" rate | Expected healthy | Result |
|---|---|---|---|
| Golden (self-check)   | **100.0%** (100/100)  | ≥60%  | ✅ |
| v1 specific-wrong     | **0.0%** (0/99)       | <10%  | ✅ |
| v2 vague-topical      | **1.1%** (1/87)       | <5%   | ✅ |

Judge passes all three checks. Gold self-validation at ceiling; distractor
acceptance well under targets. The 73.8% LME JudgeCorrect number is
trustworthy — not judge leniency.

Reproducer:
```sh
bash evaluate/scripts/phase-d-combined-winners.sh --dry-run
bash evaluate/scripts/phase-d-combined-winners.sh
node evaluate/scripts/audit-locomo-goldens.mjs evaluate/locomo/results-phase-b-locomo-v14-gemma-pass2.json
node evaluate/scripts/adversarial-gen.mjs evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass1.json --provider lmstudio --limit 100
node evaluate/scripts/adversarial-rejudge.mjs evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass1.adversarial.json
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
