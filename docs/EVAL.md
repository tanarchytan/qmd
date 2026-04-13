# Evaluation Guide

How QMD benchmarks itself, the metrics that matter, and the cost discipline we follow.

---

## How we benchmark — TL;DR

QMD runs against two long-term memory benchmarks (LongMemEval and LoCoMo) using a **local-first iteration loop** that costs nothing per run. We use remote LLMs (Gemini) for **one final answer-quality validation** at the end of a tuning cycle, never during retrieval iteration. The methodology has three rules:

1. **Iterate locally with `fastembed` + `--no-llm`.** Zero API keys, zero network calls, deterministic. R@K / MRR / SR@K / DR@K are all accurate without an LLM in the loop. F1 / EM / SH become noisy but stay comparable across runs.
2. **Lead reports with R@K + F1/EM/SH/MRR.** SR@K and DR@K (the MemPalace-compat metrics) are demoted to a single reference row because they ceiling on pre-filtered haystacks and cannot discriminate pipeline quality on most datasets we care about.
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

The recommended default for any retrieval tuning. Everything runs locally, no API keys needed.

```sh
# One-time fastembed install (Node package, native ONNX runtime, ~80MB)
npm install fastembed
```

### LongMemEval _s (the headline benchmark)

```sh
# Download once (~277MB, gitignored)
curl -L -o evaluate/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# 100% local, zero API cost, ~25 min for full 500Q on a laptop
QMD_EMBED_BACKEND=fastembed \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off \
QMD_INGEST_SYNTHESIS=off \
QMD_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --no-llm \
  --workers 4 --tag lme-s-local

# Quick smoke test (n=100, ~5 min)
LIMIT=100 ./evaluate/run-lme-s-local.sh
```

### LoCoMo

```sh
# Single conversation, fastembed local
QMD_EMBED_BACKEND=fastembed QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --no-llm

# Ingest is cached — subsequent runs against the same DB are seconds
```

### LongMemEval oracle (faster but ceiling'd at SR@K=100%)

```sh
curl -L -o evaluate/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json

QMD_EMBED_BACKEND=fastembed QMD_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 200 --no-llm
```

### Final answer-quality validation (paid)

Once retrieval is at parity, run **one** Gemini pass to score F1/EM/SH on real LLM answers:

```sh
GOOGLE_API_KEY=... \
QMD_EMBED_BACKEND=fastembed QMD_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 \
  --llm gemini --answer-model gemini-2.5-flash --workers 4
```

---

## The cost discipline

The single biggest lesson of the v15-v16 cycle: **never spend on Gemini during retrieval iteration**. A naive eval run on LME _s n=500 with our default v15.1 stack burns ~$0.20 per pass, and we typically need 5-10 passes to validate any change. That's $1-2 per A/B. Multiplied across categories (embed model, granularity, threshold, diversity, KG) it's easily $30+ per session.

By staying on `--no-llm` + `QMD_EMBED_BACKEND=fastembed`, the same matrix runs at $0. The trade-off:

| Metric | Available with `--no-llm`? |
|---|---|
| R@5 / R@10 / MRR | ✅ Accurate — depends only on retrieved memories |
| SR@K / DR@K | ✅ Accurate |
| F1 / EM / SH | ⚠️ Noisy — `prediction` falls back to "top memories joined and truncated" instead of an LLM answer. Becomes a rough retrieval-quality proxy |

For retrieval iteration, R@K and MRR are the discriminating signals. F1/EM/SH are validated in the final paid pass.

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

## The fastembed local backend

QMD ships a local-only embedding backend at `src/llm/fastembed.ts` that wraps the [`fastembed`](https://www.npmjs.com/package/fastembed) npm package — a Node port of the same Qdrant fastembed library MemPalace uses in their published 96.6% LME run. Same model (`all-MiniLM-L6-v2`, 384-dim ONNX), same determinism guarantees, no API keys.

### Activation

```sh
QMD_EMBED_BACKEND=fastembed
```

That's it. `embedText`, `embedTextBatch`, and `embedQuery` in `src/memory/index.ts` short-circuit to fastembed before falling through to the existing remote / `node-llama-cpp` chain. Default behavior unchanged when the env var is unset.

### Supported models

Stock models from `fastembed-js` (override via `QMD_FASTEMBED_MODEL=<name>`):

| Name | Dim | Size | Notes |
|---|---|---|---|
| `AllMiniLML6V2` | 384 | ~80 MB | Default. Same model MemPalace uses. |
| `BGESmallENV15` | 384 | ~130 MB | Often +1-2pp vs MiniLM on MTEB |
| `BGEBaseENV15` | 768 | ~440 MB | +2-3pp typically, slower |
| `MLE5Large` | 1024 | ~2.2 GB | Best quality but expensive |

First use downloads the model to `~/.cache/qmd/fastembed-models/` (override via `QMD_FASTEMBED_CACHE_DIR`). Subsequent runs are zero-cold-start.

### Properties

- **Deterministic**: same input → bit-identical output across runs. No more F1 ±3pp noise from gemini server-side replica routing.
- **No rate limits**: the LME _s n=500 ingest hits 25,000+ embed calls. Remote APIs (ZeroEntropy, OpenAI, etc.) rate-limit hard at this scale; fastembed has no concept of a rate.
- **Fast**: ~10ms/embedding on CPU. The full LME _s n=500 ingest + retrieval completes in ~25 min on a laptop, vs hours when rate-limited remotely.
- **No setup**: `npm install fastembed`, set the env var, run. No API key dance.

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

### MemPalace-compat (reference only — take with a grain of salt)

| Metric | Definition | Discriminates? |
|---|---|---|
| `SR@K` | Any top-K memory's `source_session_id` ∈ evidence sessions (MemPalace `recall_any`) | Ceilinged on LME oracle (both QMD and MemPalace score 100% at every K) |
| `DR@K` | `found_dialog_ids / len(evidence)` (MemPalace `compute_retrieval_recall`) | Honest on LoCoMo; not computable on LME |

K ∈ {5, 10, 15, 50}. **Why grain of salt:**

- **On LME oracle**, MemPalace's own benchmark scored `Recall@1 = Recall@5 = Recall@50 = 100%`. The oracle dataset is pre-filtered to relevant sessions, so any retriever that returns any memory at all trivially passes. The metric doesn't discriminate pipelines on this dataset — it's a ceiling.
- **On LoCoMo session granularity**, same thing: 19 docs per conversation with top-50 retrieval means every session is always in top-K. MemPalace's own run scored 100% on all 304 questions.
- **LoCoMo dialog granularity is the one honest comparison**: QMD v15.1 DR@50 = 74.9% vs MemPalace own run DR@50 = 74.8% — parity on their metric with their own pipeline on the same data.

The take-home: **SR@K and DR@K have strong caveats and should never be reported as headline numbers**. Lead with R@K (discriminates real retriever changes) plus F1/EM/SH (measure synthesis quality).

## SOTA Reference (LongMemEval published scores)

All published LongMemEval scores below are on `longmemeval_s_cleaned` (the large unfiltered haystack), **not** the `oracle` dataset QMD's day-to-day benchmarks use. Comparing QMD numbers to these figures requires running on `_s`.

| System | LME _s R@5 | Architecture | Headline metric |
|--------|-----------|--------------|---|
| **Hindsight** | **91.4%** | semantic + BM25 + entity graph + temporal + cross-encoder rerank + reflect | session recall |
| MemPalace (raw, fastembed) | **96.6%** | ChromaDB + all-MiniLM-L6-v2 + session granularity + raw verbatim | session recall |
| SuperMemory | 81.6% | Memory graph + RAG + auto contradiction resolution | session recall |
| Zep / Graphiti | 63.8% | Temporal KG with bitemporal validity | session recall |
| Mem0 | 49.0% | Vector + KG dual-store, atomic extraction | session recall |
| **QMD v16 (raw + fastembed)** | **97.0% (n=100)** ¹ | BM25 + vec RRF + adaptive cosine + raw mode + fastembed | token-overlap recall + F1/EM/SH/MRR |
| QMD v15.1 (default stack on oracle) | R@5 87.0% · F1 50.6% | BM25 + vec + RRF + LLM rerank + merged extraction + synthesis + v11.1 prompt | full pipeline |

¹ n=100 first 100 questions of `_s_cleaned`. Full n=500 confirmation run in flight at session close.

### QMD vs MemPalace verified on same data (2026-04-13)

We don't trust published numbers. For every comparison row below, we cloned MemPalace at `~/external/mempalace` and ran their own `benchmarks/locomo_bench.py` / `benchmarks/longmemeval_bench.py` on the exact same data file QMD uses.

| Benchmark | Pipeline | Metric | Score | Notes |
|---|---|---|---|---|
| **LME _s n=500** | MemPalace own run | Recall@5 | **96.6%** | their published headline reproduced on our box |
| LME _s n=500 | MemPalace own run | Recall@1 / @3 / @10 | 80.6 / 92.6 / 98.2% | |
| LME _s n=100 | QMD raw + fastembed | R@5 / R@10 | 97.0% / 97.0% | first 100 only |
| LME _s n=100 | QMD raw + fastembed | F1 / EM / SH | 64.9% / 48.0% / 60.0% | answer-quality on top of MP's retrieval-only metric |
| LME oracle n=200 | QMD v15.1 | R@5 / R@10 | 87.0% / 93.0% | |
| LME oracle n=200 | MemPalace own run | Recall@1..50 | **100% at every K** | ceilinged — the oracle dataset's haystack is pre-filtered |
| LoCoMo conv-26+30 | QMD v15.1 | DR@50 | 74.9% | |
| LoCoMo conv-26+30 | MemPalace own run | DR@50 | 74.8% | parity on the discriminating LoCoMo metric |
| LoCoMo conv-26+30 | MemPalace own run | session recall | 100% | ceilinged — 19 docs × top-50 = every session always in top-K |

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
