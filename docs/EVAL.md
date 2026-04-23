# Evaluation Guide

How Lotl benchmarks itself, the metrics that matter, and the cost discipline we follow.

---

## How we benchmark — TL;DR

Lotl runs against two long-term memory benchmarks (LongMemEval and LoCoMo) using a **local-first iteration loop** that costs nothing per run. We use remote LLMs (Gemini) for **one final answer-quality validation** at the end of a tuning cycle, never during retrieval iteration. The methodology has three rules:

1. **Iterate locally with `transformers` + `--no-llm`.** Zero API keys, zero network calls, deterministic. `recall_any@K` / `R@K` (fractional) / MRR / NDCG@10 are all accurate without an LLM in the loop. F1 / EM / SH become noisy but stay comparable across runs.
2. **Lead reports with `recall_any@K` + `R@K` (fractional) + MRR + NDCG@10.** Content-coverage (`Cov@K`) is a qmd-internal secondary metric — NOT comparable to external benchmarks. See `devnotes/metrics/metric-discipline.md` for the full metric space walkthrough.
3. **Match MemPalace's ground truth, not their numbers.** For every comparison we run their actual `benchmarks/locomo_bench.py` and `benchmarks/longmemeval_bench.py` on the same data — published headline numbers are not a substitute. Where MemPalace makes choices that hurt production quality (e.g. no cosine threshold), we don't copy them; we ship features that adapt across both regimes.

Cost ceiling for a typical iteration cycle: **$0**. Cost ceiling for a final answer-quality validation: ~$0.30 / 500-question Gemini run.

---

## Supported Benchmarks

| Benchmark | Location | Questions | Use case |
|-----------|----------|-----------|----------|
| **LoCoMo** | `evaluate/locomo/` | conv-26 (199Q), conv-30 (105Q) | Conversational memory across long multi-session dialogues |
| **LongMemEval oracle** | `evaluate/longmemeval/` | 500Q oracle (filtered haystack) | Answer-quality with retrieval skipped (the "easy" mode) |
| **LongMemEval _s_cleaned** | `evaluate/longmemeval/` | 500Q × ~50 distractor sessions | Full retrieval test — MemPalace's published 96.6% headline is on this dataset |

Both share the same Lotl memory pipeline. They test different things and complement each other — LoCoMo is dialogue-style; LME is more institutional knowledge.

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
LOTL_EMBED_BACKEND=transformers \
LOTL_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_TRANSFORMERS_DTYPE=q8 \
LOTL_VEC_MIN_SIM=0.1 \
LOTL_TRANSFORMERS_QUIET=on \
LOTL_INGEST_EXTRACTION=off \
LOTL_INGEST_REFLECTIONS=off \
LOTL_INGEST_SYNTHESIS=off \
LOTL_INGEST_PER_TURN=off \
LOTL_RECALL_RAW=on \
LOTL_EMBED_MICROBATCH=64 \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --no-llm \
  --workers 2 --tag baseline

# Quick smoke test (n=100, ~3 min)
# Same env vars, add --limit 100

# With cross-encoder rerank (~20 min, +1.7pp MRR):
# Add LOTL_MEMORY_RERANK=on to the env vars above
```

### LoCoMo

```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_TRANSFORMERS_DTYPE=q8 LOTL_RECALL_RAW=on \
LOTL_INGEST_EXTRACTION=off LOTL_INGEST_SYNTHESIS=off \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --no-llm

# Ingest is cached — subsequent runs against the same DB are seconds
```

### LongMemEval oracle (faster but ceiling'd at recall_any@K=100%)

```sh
curl -L -o evaluate/longmemeval/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json

LOTL_EMBED_BACKEND=transformers \
LOTL_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_TRANSFORMERS_DTYPE=q8 LOTL_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds oracle --limit 200 --no-llm
```

### Final answer-quality validation (paid)

Once retrieval is at parity, run **one** Gemini pass to score F1/EM/SH:

```sh
GOOGLE_API_KEY=... \
LOTL_EMBED_BACKEND=transformers \
LOTL_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_TRANSFORMERS_DTYPE=q8 LOTL_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 \
  --llm gemini --answer-model gemini-2.5-flash --workers 2
```

---

## The cost discipline

The single biggest lesson of the v15-v16 cycle: **never spend on Gemini during retrieval iteration**. A naive eval run on LME _s n=500 with our default v15.1 stack burns ~$0.20 per pass, and we typically need 5-10 passes to validate any change. That's $1-2 per A/B. Multiplied across categories (embed model, granularity, threshold, diversity, KG) it's easily $30+ per session.

By staying on `--no-llm` + `LOTL_EMBED_BACKEND=transformers`, the same matrix runs at $0. The trade-off:

| Metric | Available with `--no-llm`? |
|---|---|
| recall_any@K (binary) | ✅ Accurate — matches agentmemory/mem0/MemPalace "R@K" |
| R@K (fractional) | ✅ Accurate — LongMemEval paper definition |
| MRR / NDCG@10 | ✅ Accurate |
| Cov@K (content-overlap) | ✅ Accurate — qmd-internal, NOT comparable externally |
| F1 / EM / SH | ⚠️ Noisy — `prediction` falls back to "top memories joined and truncated" instead of an LLM answer |

For retrieval iteration, `recall_any@K`, `R@K` (fractional), MRR, and NDCG@10 are the discriminating signals. See `devnotes/metrics/metric-discipline.md` for full metric definitions and which competitor publishes what.

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

### Naming convention — `LOTL_EVAL_*` vs `LOTL_*`

As of 2026-04-20 (Phase E #47): variables that **only exist to tune the
bench harness** use the `LOTL_EVAL_*` prefix. Variables that affect the
production library stay as `LOTL_*`.

- **New scripts / new code**: always use `LOTL_EVAL_*` for eval-only vars.
- **Legacy scripts**: unchanged. A startup bridge in
  `evaluate/shared/env-compat.ts` (applied by both `eval.mts` entry points)
  mirrors `LOTL_X ↔ LOTL_EVAL_X` in both directions, so either form keeps
  working. Tables below show the new name with the legacy `LOTL_*` form
  noted where relevant.
- **Rule of thumb**: if it only matters while running `evaluate/`, it's
  `LOTL_EVAL_*`. If it also matters when importing Lotl as a library, it
  stays `LOTL_*`.

### Ingest-side

| Var | Default | Effect |
|-----|---------|--------|
| `LOTL_INGEST_EXTRACTION` | on | Run LLM-based atomic fact extraction (extractAndStore) |
| `LOTL_INGEST_REFLECTIONS` | off | Standalone reflection extraction (now no-op; merged into extractAndStore) |
| `LOTL_INGEST_SYNTHESIS` | on | Run consolidateEntityFacts (entity profiles + timelines) per scope |
| `LOTL_INGEST_BATCH_EXTRACT` | on (LME only) | Single extraction call per question instead of per session |
| `LOTL_INGEST_PER_TURN` | on | Store each conversation turn as its own memory |
| `LOTL_INGEST_SESSION_AS_MEMORY` | on | Also store full session as one memory (larger context) |

### Recall-side (memory/index.ts)

| Var | Default | Effect |
|-----|---------|--------|
| `LOTL_RECALL_RAW` | off | Disable ALL post-RRF logic — no keyword/quoted/temporal boost, no decay weighting, no query expansion, no rerank. Pure BM25 + vector RRF. Used for apples-to-apples baseline comparisons (e.g. matching MemPalace's raw ChromaDB recipe). |
| `LOTL_MEMORY_RRF_W_BM25` / `LOTL_MEMORY_RRF_W_VEC` | 0.8 / 0.2 (Phase 6 hardcode) | RRF fusion weights. Phase 6 sweep winner. Vec-heavy (<0.5 BM25) **regresses** because mxbai-xs vec can't supply a good candidate pool — rerank can't recover from a bad pool. Env-overridable for future sweeps. |
| `LOTL_MEMORY_RERANK` | off | Set to `on` to enable cross-encoder rerank (transformers backend by default; remote via `LOTL_RERANK_BACKEND=remote`). +0.9 to +1.2pp R@5 / +0.013 MRR at BM25-heavy weights; **regresses at vec-heavy weights**. |
| `LOTL_MEMORY_RERANK_CANDIDATE_LIMIT` | 40 (hardcoded v1.0.0) | How many candidates feed the cross-encoder. Phase 6 hardcoded. |
| `LOTL_MEMORY_RERANK_BLEND_ORIGINAL` / `LOTL_MEMORY_RERANK_BLEND_RERANK` | 0.5 / 0.5 (Phase 6 hardcode) | How the normalized RRF score is blended with the normalized rerank score. α=1.0/0.0 = RRF only (sanity). α=0.0/1.0 = pure rerank order. Both sides min-max normalized to [0,1] so the ratio is meaningful. |
| `LOTL_MEMORY_MMR` | off | Set to `session` to enable session-diversity MMR. Penalizes repeat picks from the same session when candidates cluster tight on a topic. |
| `LOTL_MEMORY_EXPAND` | `keywords` | Zero-LLM multi-query expansion. `keywords` (default) fans out to top-N keyword groups. `entities` uses named entities. `off` disables. |
| `LOTL_MEMORY_SYNONYMS` | off (Phase 6 hardcode) | BM25 synonym expansion. Phase 6 sweep proved net-negative — hardcoded off in `src/memory/index.ts`. Dictionary still in `src/store/constants.ts:127` for future sweeps. |
| `LOTL_MEMORY_KG` | off | Set to `on` to inject knowledge-graph facts into the candidate pool on weak recall (< K hits). Requires populated KG via `extract-facts-batch.mjs`. |

### Answer-prompt

| Var | Default | Effect |
|-----|---------|--------|
| `LOTL_PROMPT_RULES` | v11 | `v10` minimal rules · `v11` full rules (multi-item, yes/no, synthesis, undefined) · `v11.1` adds ORDERING / DURATION / COUNTING rules · `v12` chain-of-thought + structured `Answer:`/`Cited:` output (paper-style, over-engineered in practice) · **`v13` minimal LongMemEval-paper-aligned** (memories + question only, recommended for LLM-judge runs) |
| `LOTL_ANSWER_TOP_K` | 10 | How many retrieved memories are fed into the answer prompt. Retrieval still returns 50 for metric computation (MRR@50, R@50); answer prompt uses only the top-K. Default aligned with Mem0/MemOS/EverMemOS/Zep (all use ~10). |
| `LOTL_ANSWER_MAX_CHARS` | 6000 | Per-memory character cap before the memory enters the answer prompt. LongMemEval sessions average 8,283 chars — the 2026-04-17 jump from 800→6000 is what unblocked Phase 7.1 accuracy. Note: 6000 is generous vs competitors because Lotl stores raw dialogue turns (longer atomic unit) rather than extracted short facts; Mem0/Zep/EverMemOS ingest pipelines LLM-extract to short facts (~100-300 chars) so no cap is needed. Lower if you need to fit a small-context model. |

### LLM-judge (`--judge <provider>` CLI flag)

qmd implements LongMemEval's *evaluate_qa.py* pattern: retrieve → generator LLM → judge LLM returns 1/0 on factual equivalence with the gold answer. Unlocks `avgJudgeCorrect` alongside F1/EM.

| Flag / Var | Effect |
|-----|--------|
| `--llm <provider>` | `gemini` (default), `minimax`, `poe` — generator model |
| `--judge <provider>` | When set, runs LLM-judge after each prediction. Accepts same provider names. |
| `--judge-model <model-id>` | Override the judge model (e.g. `--judge poe --judge-model gpt-4o` while `--llm poe LOTL_POE_MODEL=gpt-4o-mini` — cheap gen + strong judge). |
| `--reflect` | Enable `memoryReflect` pre-pass: distil top-K memories into ≤8 facts via the generator LLM before the answer call. Adds 1 extra LLM call/question. |
| `LOTL_POE_MODEL` | default `gpt-4o` — override the Poe model used for generation |
| `POE_API_KEY` | Required when `--llm poe` or `--judge poe`. Needs an active Poe subscription for API access. |
| `LOTL_SKIP_PREFLIGHT` | `on` to skip the pre-flight quota probe (Poe `max_tokens=16` ping before ingest; catches 402-insufficient-quota before the run starts). |

### Reproducibility

| Var | Default | Effect |
|-----|---------|--------|
| `LOTL_LLM_CACHE` | on | File-based response cache for reproducible re-runs |
| `LOTL_LLM_CACHE_PATH` | auto | Override cache path (used internally; eval scripts auto-set) |
| `LOTL_ZE_COLLECTIONS` | off | ZeroEntropy collections backend (rolled back, kept for legacy) |

---

## Resumable sweeps (2026-04-21)

Long sweeps can be killed mid-flight (Claude Code crash, session disconnect,
OOM, manual stop). Rather than losing the partial work, `sweep-flags.sh` now:

- **Reuses incomplete sweep dirs**: if `evaluate/sweeps/<name>-*/` exists
  with no `SUMMARY.md`, the next invocation lands in the same dir instead
  of creating a new timestamped one.
- **Skips completed configs**: `run_one_lme` / `run_one_locomo` short-circuit
  if `<config>/lme.json` or `locomo.json` already exists and is non-partial.

This makes re-invocation idempotent. For a multi-sweep chain (e.g. Phase 6),
`evaluate/scripts/phase6-watchdog.sh` wraps the chain with:

1. A heartbeat file at `evaluate/logs/phase6-heartbeat.txt` (`<unix-ts> <status>`,
   updated every 60s while alive).
2. Transient-error self-heal: up to 5 retries on non-zero exit, 30 s backoff
   between attempts. Resume logic means no redone configs.
3. `--status` flag: prints heartbeat age + completed sweeps + in-progress
   configs in one shot.

Agent-side cadence: a cron loop at `7 */2 * * *` (every 2 hours at :07)
reads the heartbeat + log freshness and re-invokes the watchdog if dead.
The watchdog itself still dies if Claude Code crashes (bash children get
SIGHUP with parent), so after a hard Claude crash the recovery is manually
running `bash evaluate/scripts/phase6-watchdog.sh` — it picks up where
the last config died.

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
LOTL_RECALL_DUAL_PASS=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15a --tag dualpass &
LOTL_RECALL_LOG_MOD=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15b --tag logmod &
LOTL_RECALL_MMR=on \
  npx tsx evaluate/locomo/eval.mts --conv conv-30 --db-suffix v15c --tag mmr &
LOTL_PROMPT_RULES=v10 \
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

Lotl uses `@huggingface/transformers` for local ONNX embedding and
cross-encoder reranking. No API keys, deterministic, no rate limits.

### Activation

```sh
LOTL_EMBED_BACKEND=transformers
LOTL_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1  # production default
LOTL_TRANSFORMERS_DTYPE=q8                                    # int8 quantized
```

### Production embed model

| Model | Dim | Quantization | LME rAny@5 | Notes |
|---|---|---|---|---|
| **mxbai-embed-xsmall-v1** | 384 | q8 | **98.0%** | Production default. Best overall on LME. |
| all-MiniLM-L6-v2 | 384 | uint8 | ~95% | agentmemory's default. Weaker on preference. |

See `~/.claude/.../memory/project_hf_embed_models_tried.md` for full
list of tested + failed models (F2LLM, harrier, gemma, nomic, jina, me5).

### Cross-encoder reranker

Enabled via `LOTL_MEMORY_RERANK=on`. Default model:
`cross-encoder/ms-marco-MiniLM-L-6-v2` (22M params, q8, ~5-10ms/pair).
v1.0.0 GA stack uses `jina-reranker-v1-tiny-en` via remote (LM Studio) for
the headline numbers.

Phase 6 hardcoded the original/rerank blend at 0.5/0.5 (Phase 4 pre-RRF
data showed +1.7pp MRR at 0.1/0.9 blend, but that was an artifact of the
old additive pipeline; on rank-based RRF with normalized scores 0.5/0.5
wins by +0.002 MRR). Wall time: +33% (~20 min vs ~15 min for n=500).

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
- A 0.3 threshold drops legitimate matches → the gap that took LME _s multi-session R@5 from 100% (MemPalace) to 80% (Lotl pre-fix)

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
LOTL_VEC_MIN_SIM=adaptive    # default
LOTL_VEC_MIN_SIM=0           # take everything (most permissive — matches MemPalace)
LOTL_VEC_MIN_SIM=0.3         # legacy fixed-threshold behaviour
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

Lotl's evals now report six primary metrics and four MemPalace-compat reference metrics:

### Primary (lead with these)

| Metric | Axis | Definition |
|---|---|---|
| **R@5** | Retrieval (single-pass) | ≥50% of ground-truth tokens appear in any single top-5 memory, OR ≥70% across all top-5 combined |
| **R@10** | Retrieval (multi-pass) | Same, K=10 |
| **MRR** | Retrieval (rank quality) | `1 / rank_of_first_relevant_memory`, 0 if not in top-10. Rewards putting the answer at rank 1 vs rank 3 |
| **F1** | Answer quality (fuzzy) | SQuAD-style token overlap between prediction and truth |
| **EM** | Answer quality (strict) | Exact tokenized match |
| **SH** | Answer quality (substring) | Normalized truth ⊂ normalized prediction. Catches "27" vs "27 years old" false negatives that F1 scores 0 |

### Metric families (updated 2026-04-16 — see `devnotes/metrics/metric-discipline.md`)

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
Six hours wasted. See `devnotes/metrics/metric-discipline.md` for the full walkthrough.

## SOTA Reference (LongMemEval published scores)

All published LongMemEval scores below are on `longmemeval_s_cleaned` (the large unfiltered haystack), **not** the `oracle` dataset Lotl's day-to-day benchmarks use. Comparing Lotl numbers to these figures requires running on `_s`.

| System | recall_any@5 | R@5 (frac) | MRR | NDCG@10 | Metric type |
|--------|---|---|---|---|---|
| **Lotl (2026-04-16 best, n=500)** | **98.0%** | **93.6%** | **0.920** | **0.920** | retrieval |
| agentmemory hybrid (live, n=500) | 95.2% | — | 0.882 | 0.879 | retrieval |
| MemPalace raw (live-reproduced) | 96.6% | — | — | — | retrieval (recall_any) |
| Hindsight (Gemini-3) | — | — | — | — | **QA accuracy 91.4%** |
| SuperMemory (GPT-4o) | — | — | — | — | **QA accuracy 81.6%** |
| Zep / Graphiti | — | — | — | — | **QA accuracy 63.8%** (est.) |
| Mem0 | — | — | — | — | **QA accuracy 49.0%** (est.) |

Hindsight/SuperMemory/Zep/Mem0 publish LLM-judge QA accuracy, NOT retrieval
recall. Direct comparison requires implementing `evaluate_qa.py` (deferred).
See `devnotes/metrics/metric-discipline.md` for why these numbers are not comparable.

### Head-to-head comparisons (live-reproduced, same dataset)

We don't trust published numbers. Every comparison row was live-reproduced
on the same `longmemeval_s_cleaned.json` dataset (verified SHA-256 match
with HuggingFace `xiaowu0162/longmemeval-cleaned`).

**Lotl vs agentmemory (2026-04-16, per-bucket):**

| Bucket | qmd rAny@5 | AM rAny@5 | qmd MRR | AM MRR |
|---|---|---|---|---|
| knowledge-update | **99%** | 98.7% | **0.961** | 0.911 |
| multi-session | **99%** | 97.7% | 0.942 | 0.942 |
| single-session-asst | **100%** | 96.4% | **1.000** | 0.907 |
| single-session-pref | **93%** | 83.3% | **0.721** | 0.663 |
| single-session-user | **100%** | 90.0% | **0.941** | 0.807 |
| temporal-reasoning | 95% | **95.5%** | 0.875 | **0.884** |
| **OVERALL** | **98.0%** | 95.2% | **0.920** | 0.882 |

**Lotl vs MemPalace (2026-04-14, live-reproduced):**

| System | LME _s n=500 recall_any@5 |
|---|---|
| **Lotl (no rerank)** | **98.0%** |
| MemPalace raw | 96.6% |

**LoCoMo (2026-04-13):**

| System | DR@50 | Session recall |
|---|---|---|
| Lotl v15.1 | 74.9% | — |
| MemPalace own run | 74.8% | 100% (ceilinged) |

**Running MemPalace on our data** (reproduces both rows above — scripts
archived to `evaluate/legacy/` in the v1.0 cleanup; still runnable):

```sh
./evaluate/legacy/run-mempalace-baseline.sh
python3 evaluate/legacy/summarize-mempalace.py
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
