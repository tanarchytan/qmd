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

## SOTA Reference (LongMemEval published scores)

| System | LME Score | Architecture |
|--------|-----------|--------------|
| **Hindsight** | **91.4%** | Multi-strategy: semantic + BM25 + entity graph + temporal + cross-encoder rerank + reflect synthesis |
| SuperMemory | 81.6% | Memory graph + RAG + auto contradiction resolution |
| Zep / Graphiti | 63.8% | Temporal KG with bitemporal validity |
| Mem0 | 49.0% | Vector + KG dual-store, atomic extraction |
| QMD v15.1 | **SR@5 100% / F1 52.9%** (n=50 oracle, temporal-only subset) | BM25 + vec + RRF + LLM rerank + merged extraction + synthesis + v11.1 temporal prompt |

**QMD v15.1 LME apples-to-apples (2026-04-12, oracle, n=50, temporal-reasoning):**
- **SR@5 / SR@10 = 100.0%** (MemPalace `recall_any`, session-id match)
- Legacy R@5 = 86.0%, R@10 = 92.0% (token-overlap — mismeasures short numeric answers)
- F1 = 52.9%, EM = 28.0%

The SR@K number is directly comparable to MemPalace's 96.6%. The first baseline's "R@5 = 80%" was a token-overlap metric artifact, not a retrieval gap. **Caveat:** still only temporal-reasoning (dataset ordering); full-distribution run on `--limit 200` needed before calling any number representative.

## Apples-to-apples metrics (MemPalace alignment)

Both evals now store session/dialog metadata at ingest and report recall at four K values:

| Metric | Definition | Where |
|---|---|---|
| `SR@K` | Session-id any-match (`recall_any`) — any top-K memory's `source_session_id` in the QA's evidence sessions | LME, LoCoMo |
| `DR@K` | Dialog-level fractional recall — `found_dialog_ids / len(evidence)`; direct port of MemPalace `compute_retrieval_recall` | LoCoMo only (LME has no dialog IDs) |
| `R@K` | Legacy token-overlap — kept for backward comparison, known to mismeasure short numeric answers | both |

K ∈ {5, 10, 15, 50}. MemPalace's default is 50, but SR@5 / DR@5 are the honest numbers — K=50 is essentially "did we put it anywhere in a half-conversation window" and should be treated as a retrieval ceiling, not a headline score.

See `ROADMAP.md` for full architectural delta vs Hindsight and v16 candidate optimizations.

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
