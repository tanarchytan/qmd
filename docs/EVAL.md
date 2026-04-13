# Evaluation Guide

How to run, configure, and ablate QMD's memory benchmarks.

## Supported Benchmarks

| Benchmark | Location | Questions | Use case |
|-----------|----------|-----------|----------|
| **LoCoMo** | `evaluate/locomo/` | conv-26 (199Q), conv-30 (105Q) | Conversational memory across long sessions |
| **LongMemEval** (LME) | `evaluate/longmemeval/` | 500Q × {oracle, s, m} variants | Information-retrieval memory across many sessions |

Both share the same QMD memory pipeline. They test different things and complement each other — LoCoMo is dialogue-style; LME is more institutional knowledge.

---

## Quick Start

### LoCoMo

```sh
# Single conversation, full question set, Gemini answer model
npx tsx evaluate/locomo/eval.mts --conv conv-30 --llm gemini

# Limit + tag for ablation runs
npx tsx evaluate/locomo/eval.mts --conv conv-30 --llm gemini --limit 20 --tag quick-test

# Cached run reuses ingest DB (subsequent runs skip ingest)
# DB at evaluate/locomo/dbs/conv-30.sqlite
```

### LongMemEval

```sh
# First-time download (gitignored, ~280MB total)
curl -L -o evaluate/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
curl -L -o evaluate/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# Quick baseline (oracle = relevant sessions only, fast)
npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 50 --llm gemini --tag baseline

# Full retrieval test (s = ~47 sessions per question, slow)
npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --llm gemini --tag full-retrieval
```

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

| Metric | Meaning | What it tests |
|--------|---------|---------------|
| **R@5 / R@10** | (LoCoMo + LME) Do the answer's tokens appear in top-K retrieved memories? | Token-overlap recall — QMD's original metric |
| **SR@5 / SR@10** | (LME only) Did any retrieved memory come from a session listed in `answer_session_ids`? | Session-id recall — **apples-to-apples with MemPalace's `recall_any`** |
| **F1** | Token overlap between LLM answer and ground truth | Answer quality |
| **EM** | Exact tokenized match | Answer precision |

**R@K vs SR@K matters for cross-system comparison.** MemPalace's published 96.6% LongMemEval R@5 is `recall_any` based on session id intersection. To compare fairly with their numbers, use the SR@K columns.

**R@K rewards retrieval; F1/EM reward synthesis.** Both matter — high R@K with low F1 means retrieval is finding the answer but the LLM can't use it. High F1 with low R@K means the LLM is reasoning from indirect context (synthesis is doing real work).

Watch by category:
- LoCoMo: single-hop, multi-hop, temporal, open-domain, adversarial
- LME: temporal-reasoning, multi-session, knowledge-update, single-session-{user, assistant, preference}

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

| System | LME Score | Architecture |
|--------|-----------|--------------|
| **Hindsight** | **91.4%** | Multi-strategy: semantic + BM25 + entity graph + temporal + cross-encoder rerank + reflect synthesis |
| SuperMemory | 81.6% | Memory graph + RAG + auto contradiction resolution |
| Zep / Graphiti | 63.8% | Temporal KG with bitemporal validity |
| Mem0 | 49.0% | Vector + KG dual-store, atomic extraction |
| MemPalace (raw) | 96.6% | ChromaDB + all-MiniLM-L6-v2 + session granularity + raw verbatim |
| QMD v15.1 (oracle) | R@5 87.0% · F1 50.6% | BM25 + vec + RRF + LLM rerank + merged extraction + synthesis + v11.1 temporal prompt |

**QMD vs MemPalace verified on same data** (2026-04-13):

| Benchmark | Pipeline | Metric | Score |
|---|---|---|---|
| LME oracle n=200 | QMD v15.1 | R@5 / R@10 | 87.0% / 93.0% |
| LME oracle n=200 | MemPalace own run | Recall@5 / Recall@10 | 100% / 100% (ceilinged) |
| LoCoMo conv-26+30 | QMD v15.1 | DR@50 | 74.9% |
| LoCoMo conv-26+30 | MemPalace own run | DR@50 | 74.8% |

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
