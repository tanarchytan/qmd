# Evaluation Guide

How QMD benchmarks itself, the metrics that matter, and the cost discipline we follow.

---

## How we benchmark — TL;DR

QMD runs against two long-term memory benchmarks (LongMemEval and LoCoMo) using a **local-first iteration loop** that costs nothing per run. We use remote LLMs (Gemini) for **one final answer-quality validation** at the end of a tuning cycle, never during retrieval iteration. The methodology has three rules:

1. **Iterate locally with `transformers` + `--no-llm`.** Zero API keys, zero network calls, deterministic. `recall_any@K` / `R@K` (fractional) / MRR / NDCG@10 are all accurate without an LLM in the loop. F1 / EM / SH become noisy but stay comparable across runs.
2. **Lead reports with `recall_any@K` + `R@K` (fractional) + MRR + NDCG@10.** Content-coverage (`Cov@K`) is a qmd-internal secondary metric — NOT comparable to external benchmarks. See `docs/notes/metrics.md` for the full metric space walkthrough.
3. **Match MemPalace's ground truth, not their numbers.** For every comparison we run their actual `benchmarks/locomo_bench.py` and `benchmarks/longmemeval_bench.py` on the same data — published headline numbers are not a substitute. Where MemPalace makes choices that hurt production quality (e.g. no cosine threshold), we don't copy them; we ship features that adapt across both regimes.

Cost ceiling for a typical iteration cycle: **$0**. Cost ceiling for a final answer-quality validation: ~$0.30 / 500-question Gemini run.

---

## Supported Benchmarks

| Benchmark | Location | Questions | Use case |
|-----------|----------|-----------|----------|
| **LoCoMo** | `evaluate/locomo/` | conv-26 (199Q), conv-30 (105Q) | Conversational memory across long multi-session dialogues |
| **LongMemEval oracle** | `evaluate/longmemeval/` | 500Q oracle (filtered haystack) | Answer-quality with retrieval skipped (the "easy" mode) |
| **LongMemEval _s_cleaned** | `evaluate/longmemeval/` | 500Q × ~50 distractor sessions | Full retrieval test — MemPalace's published 96.6% headline is on this dataset |

Both share the same QMD memory pipeline. They test different things and complement each other — LoCoMo is dialogue-style; LME is more institutional knowledge.

---

## Quick Start — local zero-cost iteration

The recommended default for any retrieval tuning. Everything runs locally
via `@huggingface/transformers` (ONNX, no API keys).

### LongMemEval _s (the headline benchmark)

```sh
# Download once (~277MB, gitignored)
curl -L -o evaluate/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# Full n=500 run (~15 min, zero API cost)
QMD_EMBED_BACKEND=transformers \
QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
QMD_TRANSFORMERS_DTYPE=q8 \
QMD_VEC_MIN_SIM=0.1 \
QMD_TRANSFORMERS_QUIET=on \
QMD_INGEST_EXTRACTION=off \
QMD_INGEST_REFLECTIONS=off \
QMD_INGEST_SYNTHESIS=off \
QMD_INGEST_PER_TURN=off \
QMD_RECALL_RAW=on \
QMD_EMBED_MICROBATCH=64 \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --no-llm \
  --workers 2 --tag baseline

# Quick smoke test (n=100, ~3 min)
# Same env vars, add --limit 100

# With cross-encoder rerank (~20 min, +1.7pp MRR):
# Add QMD_MEMORY_RERANK=on to the env vars above
```

### LoCoMo

```sh
QMD_EMBED_BACKEND=transformers \
QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
QMD_TRANSFORMERS_DTYPE=q8 QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --no-llm

# Ingest is cached — subsequent runs against the same DB are seconds
```

### LongMemEval oracle (faster but ceiling'd at recall_any@K=100%)

```sh
curl -L -o evaluate/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json

QMD_EMBED_BACKEND=transformers \
QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
QMD_TRANSFORMERS_DTYPE=q8 QMD_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 200 --no-llm
```

### Final answer-quality validation (paid)

Once retrieval is at parity, run **one** Gemini pass to score F1/EM/SH:

```sh
GOOGLE_API_KEY=... \
QMD_EMBED_BACKEND=transformers \
QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
QMD_TRANSFORMERS_DTYPE=q8 QMD_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 \
  --llm gemini --answer-model gemini-2.5-flash --workers 2
```

---

## The cost discipline

The single biggest lesson of the v15-v16 cycle: **never spend on Gemini during retrieval iteration**. A naive eval run on LME _s n=500 with our default v15.1 stack burns ~$0.20 per pass, and we typically need 5-10 passes to validate any change. That's $1-2 per A/B. Multiplied across categories (embed model, granularity, threshold, diversity, KG) it's easily $30+ per session.

By staying on `--no-llm` + `QMD_EMBED_BACKEND=transformers`, the same matrix runs at $0. The trade-off:

| Metric | Available with `--no-llm`? |
|---|---|
| recall_any@K (binary) | ✅ Accurate — matches agentmemory/mem0/MemPalace "R@K" |
| R@K (fractional) | ✅ Accurate — LongMemEval paper definition |
| MRR / NDCG@10 | ✅ Accurate |
| Cov@K (content-overlap) | ✅ Accurate — qmd-internal, NOT comparable externally |
| F1 / EM / SH | ⚠️ Noisy — `prediction` falls back to "top memories joined and truncated" instead of an LLM answer |

For retrieval iteration, `recall_any@K`, `R@K` (fractional), MRR, and NDCG@10 are the discriminating signals. See `docs/notes/metrics.md` for full metric definitions and which competitor publishes what.

---

## Quick Start — paid mode (for reference)

The way it used to work (and still does with `--llm gemini`):

---

## CLI Flags

| Flag | Both | LoCoMo | LME | Notes |
|------|------|--------|-----|-------|
| `--llm gemini\|minimax` | ✓ | ✓ | ✓ | LLM provider for answer generation |
| `--model <name>` | ✓ | ✓ | ✓ | Override BOTH extract and answer model (e.g. `--model gemini-2.5-flash-lite`) |
| `--extract-model <name>` | ✓ | ✓ | ✓ | Override only the extraction model (use cheaper model for ingest) |
| `--answer-model <name>` | ✓ | ✓ | ✓ | Override only the answer model (keep full model for final answers) |
| `--limit N` | ✓ | ✓ | ✓ | First N questions only |
| `--tag <name>` | ✓ | ✓ | ✓ | Output filename: `results-<tag>.json` |
| `--db-suffix <name>` | ✓ | ✓ | ✓ | Cached DB filename: `conv-30-<suffix>.sqlite` |
| `--no-llm` | ✓ | ✓ | ✓ | Skip answer generation (retrieval-only) |
| `--conv <id>` | LoCoMo | ✓ | — | conv-26 or conv-30 |
| `--ds <variant>` | LME | — | ✓ | oracle / s / m |
| `--type <category>` | LME | — | ✓ | Filter by question_type |
| `--shard N/M` | LME | — | ✓ | Process every Mth question starting at N (parallel sharding) |

---

## Environment Variable Toggles

All toggles default to the v15-final configuration. Override to ablate.

### Ingest-side

| Var | Default | Effect |
|-----|---------|--------|
| `QMD_INGEST_EXTRACTION` | on | Run LLM-based atomic fact extraction (extractAndStore) |
| `QMD_INGEST_REFLECTIONS` | off | Standalone reflection extraction (now no-op; merged into extractAndStore) |
| `QMD_INGEST_SYNTHESIS` | on | Run consolidateEntityFacts (entity profiles + timelines) per scope |
| `QMD_INGEST_BATCH_EXTRACT` | on (LME only) | Single extraction call per question instead of per session |
| `QMD_INGEST_PER_TURN` | on | Store each conversation turn as its own memory |
| `QMD_INGEST_SESSION_AS_MEMORY` | on | Also store full session as one memory (larger context) |

### Recall-side (memory/index.ts)

| Var | Default | Effect |
|-----|---------|--------|
| `QMD_RECALL_RAW` | off | Disable ALL post-RRF logic — no keyword/quoted/temporal boost, no decay weighting, no query expansion, no rerank. Pure BM25 + vector RRF. Used for apples-to-apples baseline comparisons (e.g. matching MemPalace's raw ChromaDB recipe). |

### Answer-prompt

| Var | Default | Effect |
|-----|---------|--------|
| `QMD_PROMPT_RULES` | v11 | `v10` = minimal rules, `v11` = full rules (multi-item, yes/no, synthesis, undefined detection) |

### Reproducibility

| Var | Default | Effect |
|-----|---------|--------|
| `QMD_LLM_CACHE` | on | File-based response cache for reproducible re-runs |
| `QMD_LLM_CACHE_PATH` | auto | Override cache path (used internally; eval scripts auto-set) |
| `QMD_ZE_COLLECTIONS` | off | ZeroEntropy collections backend (rolled back, kept for legacy) |

---

## Common Workflows

### Ablation matrix (cached DB, parallel)

```sh
# 1. Build the cached DB once
npx tsx evaluate/locomo/eval.mts --conv conv-30 --tag baseline

# 2. Copy DB N times for parallel runs (each run touches access counts)
cd evaluate/locomo/dbs
for v in v15a v15b v15c v15d; do cp conv-30.sqlite conv-30-$v.sqlite; done

# 3. Run variants in parallel
QMD_RECALL_DUAL_PASS=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15a --tag dualpass &
QMD_RECALL_LOG_MOD=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15b --tag logmod &
QMD_RECALL_MMR=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15c --tag mmr &
QMD_PROMPT_RULES=v10 \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15d --tag promptv10 &
wait
```

Each completes in ~5 min (no ingest needed) → ~5-7 min total wall time.

### LME parallel sharded run (full 500Q)

```sh
# 8-way shard for ~6x speedup
for i in $(seq 0 7); do
  npx tsx evaluate/longmemeval/eval.mts --ds s --shard $i/8 --tag lme-s &
done
wait

# Merge results
npx tsx evaluate/longmemeval/merge-shards.mts --tag lme-s --shards 8
```

Each shard creates its own DB (`lme-s-shard0of8.sqlite`, ...) so SQLite WAL doesn't contend.

### Cross-conversation validation

```sh
# Run same config on both LoCoMo conversations
for conv in conv-26 conv-30; do
  npx tsx evaluate/locomo/eval.mts --conv $conv --tag v15final-$conv
done

# Compare F1 difference; if Δ > 5pp, config is conv-specific
```

---

## The transformers.js local backend

QMD uses `@huggingface/transformers` for local ONNX embedding and
cross-encoder reranking. No API keys, deterministic, no rate limits.

### Activation

```sh
QMD_EMBED_BACKEND=transformers
QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1  # production default
QMD_TRANSFORMERS_DTYPE=q8                                    # int8 quantized
```

### Production embed model

| Model | Dim | Quantization | LME rAny@5 | Notes |
|---|---|---|---|---|
| **mxbai-embed-xsmall-v1** | 384 | q8 | **98.0%** | Production default. Best overall on LME. |
| all-MiniLM-L6-v2 | 384 | uint8 | ~95% | agentmemory's default. Weaker on preference. |

See `~/.claude/.../memory/project_hf_embed_models_tried.md` for full
list of tested + failed models (F2LLM, harrier, gemma, nomic, jina, me5).

### Cross-encoder reranker

Enabled via `QMD_MEMORY_RERANK=on`. Default model:
`cross-encoder/ms-marco-MiniLM-L-6-v2` (22M params, q8, ~5-10ms/pair).

Adds +1.7pp MRR at 0.1/0.9 blend (10% original + 90% cross-encoder).
Wall time: +33% (~20 min vs ~15 min for n=500).

### Properties

- **Deterministic**: same input → bit-identical output across runs
- **No rate limits**: LME n=500 ingest hits 25,000+ embed calls, no throttling
- **Fast**: ~10ms/embedding on CPU, full n=500 in ~15 min
- **No setup**: models auto-download on first use to `~/.cache/huggingface/`

---

## Adaptive vector-similarity gate

The legacy 0.3 fixed cosine cutoff is replaced (as of 2026-04-13) by an adaptive algorithm in `pickVectorMatches()` (`src/memory/index.ts`). This is a quality fix, not a benchmark hack — the old fixed threshold worked well on open vaults but broke on focused haystacks.

### The two regimes

**Open vault** (production: 10k+ memories, mostly unrelated to any given query):
- Top-1 vector match typically scores 0.6-0.9 cosine
- Long tail at 0.05-0.2 is genuine noise
- A 0.3 threshold prunes the noise correctly

**Focused haystack** (LME _s, oracle, LoCoMo — every candidate session pre-filtered to one conversation):
- Top-1 vector match typically scores 0.20-0.35 cosine
- Everything in the haystack is on-topic, so even the right answer might score 0.18
- A 0.3 threshold drops legitimate matches → the gap that took LME _s multi-session R@5 from 100% (MemPalace) to 80% (QMD pre-fix)

### The algorithm

```
floor = max(absFloor=0.05, top1 × relRatio=0.5)
accept r if r.similarity ≥ floor
also keep at least minKeep=5 results regardless of similarity (safety net)
```

| Regime | top1 | floor | result |
|---|---|---|---|
| Open vault, clear answer | 0.85 | 0.425 | Long tail pruned proportional to query strength |
| Focused haystack, multi-hop | 0.32 | 0.16 | Low-cosine legitimate matches survive |
| Weak-signal query | 0.04 | 0.05 | All fail floor → minKeep=5 kicks in, BM25 fills the rest |

### Override

```sh
QMD_VEC_MIN_SIM=adaptive    # default
QMD_VEC_MIN_SIM=0           # take everything (most permissive — matches MemPalace)
QMD_VEC_MIN_SIM=0.3         # legacy fixed-threshold behaviour
```

7 unit tests in `test/pick-vector-matches.test.ts` lock the algorithm down across all three regimes plus edge cases (empty input, sort order, fixed override).

### Why we don't just match MemPalace's "no threshold ever"

MemPalace gets 100% on multi-session LME _s by taking unconditional top-K. That works **only because their benchmark always operates against pre-filtered haystacks**. On a real production vault with 10k+ memories, returning unconditional top-50 means the LLM answer model wades through 30-40 noise memories per query. Adaptive does the right thing in both cases without forcing the user to know which one they're in — that's a quality improvement, not a benchmark trick.

---

## Reproducibility Notes

### LLM nondeterminism

Even at `temperature=0`, Gemini responses vary ~3-7pp on F1/R@K across runs due to:
- Server-side replica routing
- Floating-point non-associativity
- Silent model checkpoint updates

**Mitigations in place:**
- `seed=42` passed in all generation calls (best-effort, not guaranteed)
- File-based response cache (`evaluate/locomo/llm-cache.json`) keyed by `sha256(model + temperature + seed + prompt)`
- Cache hit on identical prompts → 100% reproducible

**Cache invalidation:** when prompts change, delete the cache. Otherwise re-runs return stale answers.

```sh
rm evaluate/locomo/llm-cache.json
rm evaluate/longmemeval/llm-cache.json
```

### Model name pitfalls

- **Use `gemini-2.5-flash`** (the bare name). Verified working.
- ❌ `gemini-2.5-flash-001` does NOT exist (caused F1=5.9% disaster mid-session).
- Available variants: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`
- List models: `curl https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY`

### Cross-conversation variance

Single-conversation scores are unreliable. The LoCoMo audit ([github.com/dial481/locomo-audit](https://github.com/dial481/locomo-audit)) finds:
- 6.4% of LoCoMo questions have wrong ground truth (theoretical ceiling: 93.57%)
- Adversarial category 5 broken in upstream eval
- Open-domain category needs ≥15pp gap for statistical significance
- Judge leniency: 62.81% accept rate on vague-wrong answers

**Always validate winners on at least 2 conversations** before claiming a real improvement. Require ≥5pp gain to claim a win (below noise floor otherwise).

---

## Interpreting Results

**R@K rewards retrieval; F1/EM/SH reward synthesis.** Both matter — high R@K with low F1 means retrieval is finding the answer but the LLM can't use it. High F1 with low R@K means the LLM is reasoning from indirect context (synthesis is doing real work). Watch them together.

Watch by category:
- LoCoMo: single-hop, multi-hop, temporal, open-domain, adversarial
- LME: temporal-reasoning, multi-session, knowledge-update, single-session-{user, assistant, preference}

Per-category gaps usually point at one specific failure mode. Examples from the v16 cycle:

- **LME _s n=500 multi-session R@5 = 80%** (vs MemPalace 100%) → root cause was a fixed cosine threshold dropping legitimate matches at 0.18-0.25. Diagnosed via per-category breakdown, not the global R@5. Fix: adaptive threshold.
- **LoCoMo single-hop F1 dropped 7pp** when reflect synthesis was enabled → the reflect call over-compresses single-hop questions. Fix: smart-gate reflect by question type (deferred).

---

## Metric hierarchy

QMD's evals now report six primary metrics and four MemPalace-compat reference metrics:

### Primary (lead with these)

| Metric | Axis | Definition |
|---|---|---|
| **R@5** | Retrieval (single-pass) | ≥50% of ground-truth tokens appear in any single top-5 memory, OR ≥70% across all top-5 combined |
| **R@10** | Retrieval (multi-pass) | Same, K=10 |
| **MRR** | Retrieval (rank quality) | `1 / rank_of_first_relevant_memory`, 0 if not in top-10. Rewards putting the answer at rank 1 vs rank 3 |
| **F1** | Answer quality (fuzzy) | SQuAD-style token overlap between prediction and truth |
| **EM** | Answer quality (strict) | Exact tokenized match |
| **SH** | Answer quality (substring) | Normalized truth ⊂ normalized prediction. Catches "27" vs "27 years old" false negatives that F1 scores 0 |

### Metric families (updated 2026-04-16 — see `docs/notes/metrics.md`)

| Family | What it computes | Who uses it | eval.mts field |
|---|---|---|---|
| **recall_any@K** (binary) | 1 if any gold session in top-K | agentmemory, mem0, MemPalace ("R@K") | `r_any5/10/20` |
| **R@K** (fractional) | `\|gold ∩ top_k\| / \|gold\|` | LongMemEval paper | `r5/10/15/20/50` |
| **MRR** | `1 / rank_of_first_gold` | all sources (consistent) | `mrr` |
| **NDCG@10** | DCG / IDCG with per-question `min(k, \|gold\|)` | LME paper | `ndcg10` |
| **Cov@K** (content-overlap) | token overlap with answer text | qmd-internal only | `cov_r5/10/20` |
| **QA accuracy** (LLM-judge) | generate answer + judge 0/1 | Supermemory, Hindsight | not implemented |

**Never compare across families.** The 2026-04-15 "82% multi-session
ceiling" was caused by comparing qmd's Cov@5 to agentmemory's recall_any@5.
Six hours wasted. See `docs/notes/metrics.md` for the full walkthrough.

## SOTA Reference (LongMemEval published scores)

All published LongMemEval scores below are on `longmemeval_s_cleaned` (the large unfiltered haystack), **not** the `oracle` dataset QMD's day-to-day benchmarks use. Comparing QMD numbers to these figures requires running on `_s`.

| System | recall_any@5 | R@5 (frac) | MRR | NDCG@10 | Metric type |
|--------|---|---|---|---|---|
| **QMD (2026-04-16 best, n=500)** | **98.0%** | **93.6%** | **0.920** | **0.920** | retrieval |
| agentmemory hybrid (live, n=500) | 95.2% | — | 0.882 | 0.879 | retrieval |
| MemPalace raw (live-reproduced) | 96.6% | — | — | — | retrieval (recall_any) |
| Hindsight (Gemini-3) | — | — | — | — | **QA accuracy 91.4%** |
| SuperMemory (GPT-4o) | — | — | — | — | **QA accuracy 81.6%** |
| Zep / Graphiti | — | — | — | — | **QA accuracy 63.8%** (est.) |
| Mem0 | — | — | — | — | **QA accuracy 49.0%** (est.) |

Hindsight/SuperMemory/Zep/Mem0 publish LLM-judge QA accuracy, NOT retrieval
recall. Direct comparison requires implementing `evaluate_qa.py` (deferred).
See `docs/notes/metrics.md` for why these numbers are not comparable.

### Head-to-head comparisons (live-reproduced, same dataset)

We don't trust published numbers. Every comparison row was live-reproduced
on the same `longmemeval_s_cleaned.json` dataset (verified SHA-256 match
with HuggingFace `xiaowu0162/longmemeval-cleaned`).

**QMD vs agentmemory (2026-04-16, per-bucket):**

| Bucket | qmd rAny@5 | AM rAny@5 | qmd MRR | AM MRR |
|---|---|---|---|---|
| knowledge-update | **99%** | 98.7% | **0.961** | 0.911 |
| multi-session | **99%** | 97.7% | 0.942 | 0.942 |
| single-session-asst | **100%** | 96.4% | **1.000** | 0.907 |
| single-session-pref | **93%** | 83.3% | **0.721** | 0.663 |
| single-session-user | **100%** | 90.0% | **0.941** | 0.807 |
| temporal-reasoning | 95% | **95.5%** | 0.875 | **0.884** |
| **OVERALL** | **98.0%** | 95.2% | **0.920** | 0.882 |

**QMD vs MemPalace (2026-04-14, live-reproduced):**

| System | LME _s n=500 recall_any@5 |
|---|---|
| **QMD (no rerank)** | **98.0%** |
| MemPalace raw | 96.6% |

**LoCoMo (2026-04-13):**

| System | DR@50 | Session recall |
|---|---|---|
| QMD v15.1 | 74.9% | — |
| MemPalace own run | 74.8% | 100% (ceilinged) |

**Running MemPalace on our data** (reproduces both rows above):

```sh
./evaluate/run-mempalace-baseline.sh
python3 evaluate/summarize-mempalace.py
```

Results land in `~/external/mempalace-results/`.

---

## Output Files

Each eval writes:
- `evaluate/<benchmark>/results-<tag>.json` — full per-question results + summary
- `evaluate/<benchmark>/dbs/<conv-id>-<suffix>.sqlite` — cached ingest DB (gitignored)
- `evaluate/<benchmark>/llm-cache.json` — response cache (gitignored)

Inspect a result:
```sh
node -e 'const r=require("./evaluate/locomo/results-myrun.json");
  console.log(JSON.stringify(r.summary, null, 2))'
```
