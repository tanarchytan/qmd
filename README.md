# Lotl 🦎 — Living-off-the-Land Memory for AI Agents

> *"I'll build my own memory framework — with FTS5 and sqlite-vec."*

A unified search + memory + knowledge-graph system that runs on what's already on your machine. No new infra, no LLM required, no cloud dependency. Everything lives in one SQLite database.

**Document search:** BM25 + vector + RRF fusion + LLM reranking across markdown, code, and notes.
**Agent memory:** Store, recall, forget, and extract memories with automatic deduplication and Weibull decay.
**Knowledge graph:** Temporal subject-predicate-object triples — "what was true when?"

**Lotl** = *Living-off-the-Land* (the cybersecurity term for "use what's already there to avoid new infrastructure"). Repurposed here: FTS5 + sqlite-vec + local ONNX embeddings via `@huggingface/transformers`. Cloud APIs (ZeroEntropy, SiliconFlow, Nebius, Gemini, OpenAI) are opt-in, not required.

> Evolved from a fork of [tobi/qmd](https://github.com/tobilu/qmd) — see the origin story below. CLI binary `lotl` is the canonical name; `qmd` stays as an alias for existing installs. Env vars are `LOTL_*`; `qmd://` virtual-path callers should migrate to `lotl://`.

```sh
npm install -g @tanarchy/lotl
```

## Quick Start

```sh
# Index your documents
lotl collection add ~/notes --name notes
lotl collection add ~/work/docs --name docs
lotl context add lotl://notes/ "Personal notes and ideas"
lotl context add lotl://docs/ "Work documentation"
lotl embed

# Search
lotl search "project timeline"           # BM25 keyword search
lotl vsearch "how to deploy"             # Vector semantic search
lotl query "quarterly planning process"  # Hybrid + reranking (best quality)

# Get documents
lotl get "docs/api-reference.md"
lotl get "#abc123"                        # by docid
lotl multi-get "journals/2025-05*.md"     # by glob pattern
```

## MCP Server

Lotl exposes all functionality via MCP (Model Context Protocol). Works with Claude Desktop, Claude Code, Cursor, OpenClaw, and any MCP client.

### Document tools
| Tool | Description |
|------|-------------|
| `query` | Hybrid search with typed sub-queries (lex/vec/hyde) + reranking |
| `get` | Retrieve document by path or docid |
| `multi_get` | Batch retrieve by glob or comma-separated list |
| `status` | Index health and collection info |
| `briefing` | Agent wake-up context: collections, contexts, search strategy |

### Memory tools
| Tool | Description |
|------|-------------|
| `memory_add` / `memory_add_batch` | Store memory/memories with auto-dedup (hash + cosine) and auto-classification |
| `memory_search` | Hybrid search (FTS + vector RRF fusion + keyword expansion + synonym expansion) |
| `memory_recall_tiered` | Search grouped by tier (core/working/peripheral), per-tier limit |
| `memory_push_pack` | Pre-query bundle for session start — core + important-recent + hot-tail |
| `memory_get` / `memory_list` | Fetch by id / list by filters |
| `memory_delete` / `memory_update` | Delete / update text, importance, category (re-embeds on text change) |
| `memory_extract` | Extract memories from conversation text (LLM + heuristic fallback) |
| `memory_reflect` / `memory_dream` | Post-retrieval synthesis / overnight consolidation |
| `memory_stats` | Count by tier, category, scope |
| `memory_register_scopes` | Register scopes for partition-key vec0 queries |

### Knowledge tools
| Tool | Description |
|------|-------------|
| `knowledge_add` | Store a fact with time validity (auto-invalidates conflicting prior facts) |
| `knowledge_search` | Query facts by subject/predicate/object, optionally at a point in time |
| `knowledge_invalidate` | Mark a fact as no longer valid (preserved in history) |
| `knowledge_entities` / `knowledge_timeline` / `knowledge_stats` | Enumerate entities / temporal scans / counts |

### Management tools
| Tool | Description |
|------|-------------|
| `manage` | Administrative ops: `embed`, `update`, `cleanup`, `sync`, `decay` |

### Setup

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "lotl": { "command": "lotl", "args": ["mcp"] }
  }
}
```

**Claude Code:**
```json
{
  "mcpServers": {
    "lotl": { "command": "lotl", "args": ["mcp"] }
  }
}
```

**HTTP transport** (shared daemon, models stay loaded):
```sh
lotl mcp --http --daemon           # start on localhost:8181
lotl mcp stop                      # stop
```

## ⭐ Recommended local config — beats MemPalace + agentmemory on LongMemEval

Four lines in `~/.config/lotl/.env`:

```sh
LOTL_EMBED_BACKEND=transformers
LOTL_TRANSFORMERS_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1
LOTL_TRANSFORMERS_DTYPE=q8
LOTL_VEC_MIN_SIM=0.1
```

**Benchmarks** (full reproduction recipes + per-config metrics in [`evaluate/SNAPSHOTS.md`](evaluate/SNAPSHOTS.md)).

**LongMemEval `_s` n=500** (session-id retrieval, RAW recall) — winner is mxbai-xs q8:

| System | recall_any@5 | R@5 (fractional) | MRR | NDCG@10 | Pref MRR | Wall |
|---|---|---|---|---|---|---|
| **lotl / mxbai-xs q8** (default) | **98.4%** | **93.7%** | 0.917 | 0.913 | **0.745** | 26 min |
| lotl / UAE-Large 1024d | 98.0% | 93.8% | **0.921** | **0.919** | 0.714 | 145 min |
| lotl / gte-small 384d | 97.8% | 93.2% | 0.919 | 0.914 | 0.703 | 26 min |
| lotl / bge-large 1024d | 98.0% | 93.6% | 0.917 | 0.917 | 0.680 | 147 min |
| lotl / jina-v5-nano 768d | 95.4% | 89.6% | 0.860 | 0.849 | 0.533 | ~5 h |
| agentmemory hybrid | 95.2% | — | 0.882 | 0.879 | — | — |
| MemPalace raw | 96.6% | — | — | — | — | — |

n=500 sweep across 5 candidates concluded mxbai-xs stays default — challengers cost 5-15× params for tied or worse retrieval, all regressed on preference MRR.

**LongMemEval `_s` n=500 with LLM judge** (Phase 7):

| Generator | Judge | Judge-Acc | n | Notes |
|---|---|---|---|---|
| gpt-4o (Phase 7.1b, n=100) | gpt-4o | **64.0%** | 100 | Matches LongMemEval paper baseline |
| Poe gpt-4o-mini | Poe gpt-4o | 47.0% | 134 | Quota hit at q55, partial result |
| Gemini-2.5-flash | Gemini-2.5-flash | 29.7% | 499 | Generator-bound — Gemini-flash hedges |

**LoCoMo (10 convs, n=1986) with LLM judge** — generator + judge = gemini-2.5-flash:

| Metric | Value |
|---|---|
| R@5 | 67.6% |
| MRR | 0.593 |
| F1 | 66.2% |
| **Judge-Acc** | **81.4%** |

vs published LoCoMo: Mem0 91.6% (GPT-4 class), Hindsight 89.6% (top backbone). With a stronger generator (gpt-4o, gemini-2.5-pro), Lotl's 81.4% is expected to climb into the 85-90% range on the same retrieval layer.

See [`devnotes/metrics/metric-discipline.md`](devnotes/metrics/metric-discipline.md) for `recall_any@K` (binary, agentmemory/mem0/MemPalace style) vs `R@K` (fractional, LongMemEval paper) distinction. Eval harness CLI flags + reproduction recipes in [`evaluate/longmemeval/README.md`](evaluate/longmemeval/README.md) and [`evaluate/locomo/README.md`](evaluate/locomo/README.md). Honest-harness rationale (top-k=10 not the MemPalace top-k=50 cheat) in [`evaluate/locomo/HYBRID_HARNESS.md`](evaluate/locomo/HYBRID_HARNESS.md).

**What these four lines do:**
- **Local ONNX embed** via `@huggingface/transformers` — no cmake, no GPU, ~50 MB download on first use.
- **mxbai-xs q8** — 384-dim quantized encoder; 2-3s per query on CPU.
- **`LOTL_VEC_MIN_SIM=0.1`** — overrides the adaptive cosine acceptance floor (tight-cluster q8 models need this; default floor prunes too aggressively).

**Under the hood (all shipped, no config needed):**
- Rank-based **weighted RRF fusion** (0.8 BM25 / 0.2 vec, Phase 6 hardcoded v1.0.0); proper rank normalization, not additive scores.
- **Keyword expansion** — zero-LLM sub-query fanout (default on).
- **Synonym expansion** — hardcoded **off** as of v1.0.0 (proved net-negative in Phase 6 sweeps).
- **Cross-encoder rerank** available via `LOTL_MEMORY_RERANK=on` (optional, +1-2pp MRR; blend hardcoded 0.5/0.5).

All tunables hardcoded in `src/store/constants.ts` (validated at n=500 LME). See `docs/ROADMAP.md` "2026-04-17" for full sweep history.

## Cloud Configuration

Copy `.env.example` to `~/.config/lotl/.env`. Loaded automatically.

Each operation (embed, rerank, query expansion) is configured independently:

```sh
QMD_{OP}_PROVIDER=   # local | api | url | gemini (or alias: siliconflow, openai, zeroentropy, dashscope)
QMD_{OP}_API_KEY=    # Bearer token
QMD_{OP}_URL=        # base URL (api) or full endpoint (url)
QMD_{OP}_MODEL=      # model name
```

**Provider modes:**
- `api` — OpenAI-compatible base URL (paths `/embeddings`, `/rerank`, `/chat/completions` auto-appended)
- `url` — direct endpoint URL (used as-is)
- `gemini` — Google Gemini (x-goog-api-key auth)
- Aliases: `siliconflow`, `openai`, `zeroentropy`, `dashscope` set mode + default URL automatically

### Example: ZeroEntropy embed + rerank

```sh
LOTL_EMBED_PROVIDER=zeroentropy
LOTL_EMBED_API_KEY=ze_your-key
LOTL_EMBED_MODEL=zembed-1
LOTL_RERANK_PROVIDER=zeroentropy
LOTL_RERANK_API_KEY=ze_your-key
LOTL_RERANK_MODEL=zerank-2
LOTL_RERANK_MODE=rerank
LOTL_QUERY_EXPANSION_PROVIDER=api
LOTL_QUERY_EXPANSION_API_KEY=nebius-key
LOTL_QUERY_EXPANSION_URL=https://api.studio.nebius.ai/v1
LOTL_QUERY_EXPANSION_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct
```

### Example: SiliconFlow all three operations

```sh
LOTL_EMBED_PROVIDER=siliconflow
LOTL_EMBED_API_KEY=sk-your-key
LOTL_EMBED_MODEL=Qwen/Qwen3-Embedding-8B
LOTL_RERANK_PROVIDER=siliconflow
LOTL_RERANK_API_KEY=sk-your-key
LOTL_RERANK_MODEL=BAAI/bge-reranker-v2-m3
LOTL_RERANK_MODE=rerank
LOTL_QUERY_EXPANSION_PROVIDER=siliconflow
LOTL_QUERY_EXPANSION_API_KEY=sk-your-key
LOTL_QUERY_EXPANSION_MODEL=zai-org/GLM-4.5-Air
```

Embed can also run locally via `LOTL_EMBED_BACKEND=transformers` (ONNX, opt-in). Rerank and query expansion are remote-only.

## Memory System

Agents store and recall memories alongside document search. Same database, same providers, same search pipeline.

### How it works

```
memory_store({ text: "David prefers ZeroEntropy for reranking", category: "preference", importance: 0.8 })
→ Embeds text → checks hash dedup → checks cosine dedup (≥0.9) → stores in memories + memories_fts + memories_vec

memory_recall({ query: "what reranker does David use" })
→ FTS search + vector search → RRF fusion → keyword boost → decay weighting → top results

memory_extract({ text: "We decided to use SQLite. I prefer TypeScript for backend work." })
→ Pattern matching detects [decision] and [preference] → stores each with category + importance
```

### Memory categories
- `preference` — "I prefer X", "I don't like Y"
- `fact` — "The API limit is 100/min", "David works at Tanarchy"
- `decision` — "We decided to use X", "Let's go with Y"
- `entity` — "Vincent runs Ubuntu", "Arachnid is the code agent"
- `reflection` — "I realized that...", "Looking back..."
- `other` — everything else

Auto-classified when no category is provided, using 16 regex patterns.

### Memory decay (Weibull)

Memories fade over time unless accessed frequently or marked important.

```
composite = 0.4 × recency + 0.3 × frequency + 0.3 × importance
```

Three tiers with automatic promotion:
- **Peripheral** (default) — decays fastest. Promoted to Working after 3+ accesses.
- **Working** — moderate decay. Promoted to Core after 10+ accesses + high importance.
- **Core** — slowest decay. Rarely demoted.

Run `manage({ operation: "decay" })` to evaluate and promote/demote.

## Knowledge Graph

Store facts with time validity windows. When facts change, old values are preserved with timestamps.

```
knowledge_store({ subject: "David", predicate: "prefers", object: "ZeroEntropy" })
→ Later:
knowledge_store({ subject: "David", predicate: "prefers", object: "Nebius" })
→ Auto-invalidates old "ZeroEntropy" fact, stores new "Nebius" fact

knowledge_query({ subject: "David", predicate: "prefers" })
→ Returns: David → prefers → Nebius (current)

knowledge_query({ subject: "David", as_of: <last week> })
→ Returns: David → prefers → ZeroEntropy (was valid then)
```

Entity names are auto-normalized: "David Gillot" → "david_gillot".

## Architecture

```
                    Query
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
       BM25 (FTS5)         Vector (sqlite-vec)
       keyword match       semantic similarity
          │                       │
          └───────────┬───────────┘
                      ▼
              RRF Fusion (k=60)
              BM25 weight: 0.8
              Vector weight: 0.2
                      │
                      ▼
           Zero-LLM Score Boosts
           • keyword overlap (+30%)
           • quoted phrase match (+60%)
           • person name match (+40%)
           • stop word filtering
                      │
                      ▼
              LLM Reranking (optional)
              (ZeroEntropy / SiliconFlow / Gemini / OpenAI)
                      │
                      ▼
           Rerank Blend (hardcoded v1.0.0)
           50% RRF / 50% reranker
           (was position-aware pre-Phase-6;
            sweep showed flat 0.5/0.5 wins)
                      │
                      ▼
              Final Results
```

All scoring parameters are env-configurable. See `.env.example`.

## CLI Reference

```sh
# Collections
lotl collection add <path> --name <name>
lotl collection list
lotl collection remove <name>
lotl collection rename <old> <new>
lotl ls [collection[/path]]

# Context
lotl context add [path] "description"
lotl context list
lotl context check
lotl context rm <path>

# Search
lotl search <query>              # BM25 keyword search
lotl vsearch <query>             # Vector similarity search
lotl query <query>               # Hybrid + reranking (best quality)

# Retrieval
lotl get <file>                  # by path or docid (#abc123)
lotl multi-get <pattern>         # by glob or comma-separated list

# Indexing
lotl embed                       # generate vector embeddings
lotl embed --force               # re-embed everything
lotl update                      # re-index all collections
lotl sync                        # update + embed in one command

# Maintenance
lotl status                      # index status + remote providers
lotl cleanup                     # clear cache + orphans + vacuum
lotl vacuum                      # reclaim DB space

# MCP
lotl mcp                         # stdio transport
lotl mcp --http [--port N]       # HTTP transport
lotl mcp --http --daemon         # background daemon
lotl mcp stop                    # stop daemon
```

## SDK Usage

```typescript
import { createStore } from '@tanarchy/lotl'

const store = await createStore({
  dbPath: './my-index.sqlite',
  config: {
    collections: {
      docs: { path: '/path/to/docs', pattern: '**/*.md' },
    },
  },
})

const results = await store.search({ query: "authentication flow" })
await store.close()
```

## Development

```sh
npx tsx src/cli/lotl.ts <command>   # Run CLI from source (dev mode)
npm link                            # Install globally as 'qmd'
npx vitest run test/                # Run tests
npm run build                       # Compile TypeScript to dist/
npm run typecheck                   # tsc --noEmit (no emit, just type-check)
```

Node.js ≥22 required. Bun support was dropped — all code is Node-only.

## Benchmarks

Lotl ships a **local-first, zero-cost benchmark loop** that matches MemPalace's setup exactly: local ONNX embeddings via `fastembed`, no API keys, deterministic. The cost discipline is "iterate locally with `--no-llm`, validate answer quality with one paid Gemini run at the end." A full `longmemeval_s_cleaned` n=500 retrieval pass costs **$0** and runs in ~25 min on a laptop.

**Primary metrics: R@5 / R@10 (token-overlap recall), MRR (rank quality), F1 / EM / SH (answer quality).** These actually discriminate pipeline changes. MemPalace-style session recall (SR@K) and dialog recall (DR@K) are reported as secondary reference rows; they're ceilinged or near-ceilinged on these datasets and should be taken with a grain of salt (see caveats below).

### LongMemEval _s_cleaned — the headline benchmark (500 questions × ~50 distractor sessions)

| Pipeline | n | R@5 | R@10 | F1 | EM | Cost | Time |
|---|---|---|---|---|---|---|---|
| **MemPalace raw + fastembed** (their published run) | 500 | **96.6%** | 98.2% | — | — | $0 | 12.5m |
| **Lotl raw + fastembed + scope-partitioned vec0** | 500 | **93.2%** | **95.2%** | — | — | $0 | 24m |
| Lotl raw + fastembed + adaptive cosine (n=100 first slice) | 100 | 97.0% | 97.0% | 64.9% | 48.0% | $0 | 5m |

Same embed model (`all-MiniLM-L6-v2`, 384-dim ONNX). Same dataset. Zero API keys for retrieval. Deterministic. Lotl additionally measures end-to-end answer quality (F1/EM/SH) that MemPalace's benchmark doesn't produce — their 96.6% is retrieval-only.

**Per-category performance** on full n=500 (pre-fix baseline — illustrates how diagnostic the per-category split is):

| Category | n | Lotl R@5 | MemPalace R@5 | Δ |
|---|---|---|---|---|
| single-session-user | 70 | 99% | 97% | +2 ✓ |
| single-session-assistant | 56 | 98% | 96% | +2 ✓ |
| knowledge-update | 78 | 95% | 100% | −5 |
| single-session-preference | 30 | 93% | 97% | −4 |
| temporal-reasoning | 133 | 86% | 97% | −11 |
| multi-session | 133 | 80% | 100% | −20 |

The 7-pp overall gap was concentrated in the two largest categories (multi-session + temporal-reasoning, 53% of the dataset). DB inspection traced it to a real bug: **the vec0 KNN query has no scope filter — it returned the K nearest memories across the entire 23,867-row index, and only ~0.3 hits per scope landed in the right one** (we then dropped the rest in post-vector scope filtering, leaving most queries with mem=1-5 instead of mem=50). MemPalace doesn't hit this because they create a fresh ChromaDB EphemeralClient per question.

Two fixes shipped this session:

1. **Adaptive cosine threshold** (`pickVectorMatches`, 7 unit tests) — replaces the fixed 0.3 floor with `max(0.05, top1 × 0.5)`. Quality fix for both production (open vaults) and benchmarks (focused haystacks). Documented in `docs/EVAL.md`.
2. **K-multiplier bump** (`LOTL_VEC_K_MULTIPLIER=20`) — workaround that fetches K=1000 vec hits instead of K=150, so the post-vector scope filter has enough candidates per scope to fill top-50. Architecturally proper fix (a `scope` partition key on `memories_vec`) is queued as a separate schema-migration commit.

n=500 rerun with both fixes is in flight at session-close.

### LongMemEval oracle (n=200, pre-filtered haystack)

| Pipeline | R@5 | R@10 | F1 | EM | SR@5 (MP-compat) |
|---|---|---|---|---|---|
| Lotl v15.1 | **87.0%** | **93.0%** | **50.6%** | 27.5% | 100% ceiling |
| Lotl v16.1 (reflect augment) | 84.5% | 91.5% | 49.4% | 27.0% | 100% |
| **MemPalace (own benchmark)** | **100%** | **100%** | — | — | 100% ceiling |

Oracle is pre-filtered to relevant sessions — SR@K hits 100% by construction for any retriever. Use the `_s_cleaned` row above for a meaningful comparison.

### LoCoMo conv-26 + conv-30 (n=304)

| Pipeline | R@5 | R@10 | F1 | EM | DR@50 (MP-compat) |
|---|---|---|---|---|---|
| Lotl v15-final | — | — | 60.9% | 38.6% | — |
| Lotl v15.1 | 50.0% | 60.9% | **58.6%** | 36.2% | **74.9%** |
| Lotl v16 (diversity only) | **50.9%** | **60.9%** | 58.9% | 37.2% | 75.7% |
| **MemPalace (own benchmark)** | — | — | — | — | **74.8%** |

Single-conv breakdowns and v16.1 (reflect augment) detail live in [`docs/ROADMAP.md`](docs/ROADMAP.md).

**What this says:**

- On the one metric where both sides cleanly discriminate — **LoCoMo dialog-level DR@50** — Lotl v15.1 matches MemPalace's own benchmark to within 0.1pp (74.9 vs 74.8). Parity on their metric with their own pipeline.
- On **LongMemEval oracle**, MemPalace's own benchmark scores **Recall@1 = 100%** because the oracle dataset is pre-filtered to relevant sessions — any retriever that returns anything trivially hits 100%. It's a ceiling measurement, not a comparison. Their published 96.6% headline is on the `longmemeval_s_cleaned` dataset (the fully unfiltered haystack), not oracle. Comparing our numbers to that requires running `_s` — a future benchmark.

**Caveats on the MP-compat metrics** (this is why we demote them to reference rows):
- `SR@K` (session any-match) hits 100% on LME oracle by construction — doesn't discriminate retriever quality.
- `DR@K` (dialog fractional recall) is honest but only computable on LoCoMo where the dataset exposes dialog IDs.
- Legacy R@K (token overlap) has a known blind spot on short numeric answers — "27" vs "27 years old" scored 0 pre-fix. New Substring-Hit (SH) metric catches that.

Reference SOTA on LongMemEval (per [vectorize.io memory survey](https://vectorize.io/articles/best-ai-agent-memory-systems)) — all reported on `longmemeval_s_cleaned`, not oracle:
- Hindsight 91.4% · SuperMemory 81.6% · Zep 63.8% · Mem0 49.0%

### How to reproduce — zero-cost local

```sh
# One-time
npm install fastembed
curl -L -o evaluate/longmemeval/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json

# Run the same recipe MemPalace uses, on the same dataset
LOTL_EMBED_BACKEND=fastembed \
LOTL_RECALL_RAW=on \
LOTL_INGEST_EXTRACTION=off LOTL_INGEST_SYNTHESIS=off LOTL_INGEST_PER_TURN=off \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --no-llm \
  --workers 4 --tag local-baseline
```

Full retrieval pipeline. No API keys. ~$0 cost. ~25 min wall on a laptop. Reports R@5/R@10/MRR + (noisy but comparable) F1/EM/SH.

For end-to-end answer quality, add `--llm gemini` and a `GOOGLE_API_KEY` — that's the only paid call in the cycle.

### How we benchmark

QMD's benchmark methodology is documented in [`docs/EVAL.md`](docs/EVAL.md). The headlines:

1. **Local-first iteration** with `fastembed` + `--no-llm` — costs nothing, deterministic, no rate limits.
2. **Lead with metrics that discriminate**: R@K + F1/EM/SH/MRR. SR@K and DR@K are demoted to a single MemPalace-compat reference row.
3. **Match ground truth, not headline numbers** — for every comparison, run MemPalace's own benchmark on the same data via `evaluate/run-mempalace-baseline.sh`.
4. **Don't adopt MemPalace's questionable choices** (no cosine threshold, session-only granularity, no LLM extraction). Instead, ship features that adapt across both regimes (e.g. adaptive cosine threshold replaces fixed 0.3 — quality fix for both production and benchmark).

Full version history, technique tables, lessons learned, and SOTA targets in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Standing on the Shoulders of Giants

Lotl is a pile of good ideas from other projects, glued together with one
SQLite database and a lot of benchmarking. Everything below is shipped and
verified in code.

### Foundation

[**tobi/qmd**](https://github.com/tobi/qmd) — Tobi Lutke's original QMD.
SQLite FTS5 + sqlite-vec hybrid search, AST-aware chunking via tree-sitter,
the MCP server, session management, the entire CLI scaffolding. We forked
this and grew the memory system on top.

### Memory & retrieval architecture

[**MemPalace**](https://github.com/milla-jovovich/mempalace) — the project
that pushed us past 90% R@5 on LongMemEval.
- Raw verbatim storage as the baseline (their 96.6% R@5 head-to-head)
- Zero-LLM score boosts: keyword overlap (×1.4), quoted phrase (×1.6),
  person name filter, stop-word list
- Temporal distance boost (40% time-proximate)
- Preference pattern ingest
- Strong-signal detection (skip query expansion when FTS hits clean)
- Per-question scope isolation pattern (we implement it as
  `memories_vec` PARTITION KEY)
- Honest benchmarking methodology that set our standard

[**Mem0**](https://github.com/mem0ai/mem0) — atomic-fact extraction and
dedup pipeline.
- LLM atomic fact extraction with categories
- Two-layer dedup: MD5 content hash (instant) + cosine similarity ≥0.9
- Memory changelog table for audit trails
- LLM conflict resolution (ADD / UPDATE / DELETE / NONE) — fully shipped
- Multi-agent namespace isolation
- OpenClaw plugin auto-recall / auto-capture hook pattern

[**Mastra**](https://github.com/mastra-ai/mastra) — TypeScript memory
processing patterns.
- Embedding LRU cache (we use MD5 keys instead of xxhash64; functionally
  equivalent at our scale)
- Per-scope memory boundaries (informed our `scope` field design)

[**memory-lancedb-pro**](https://github.com/CortexReach/memory-lancedb-pro) —
the most complete memory lifecycle layer we found.
- Weibull decay engine (recency × frequency × intrinsic, β per tier) —
  ported directly to `src/memory/decay.ts`
- Three-tier promotion: peripheral → working → core
- Smart extraction with 6 categories matching ours
- Dream consolidation with cursor checkpointing — wired into our OpenClaw
  plugin's `session_end` hook

[**Zep / Graphiti**](https://github.com/getzep/graphiti) — temporal
knowledge graph schema.
- Bitemporal validity windows on facts (`valid_from` / `valid_until`)
- Auto-invalidation of conflicting facts
- Inspired our `knowledge_store` / `knowledge_query` API and the
  `consolidateEntityFacts` synthesis pass

[**Letta / MemGPT**](https://github.com/letta-ai/letta) — agent
self-directed retrieval via tool calls. We expose this through the MCP
server's `memory_recall` and `memory_store` tools, letting the agent
choose when to recall vs ingest.

[**Tinkerclaw — Serra (2026)**](https://github.com/globalcaos/tinkerclaw) —
three OpenClaw memory papers (Instant Recall, Total Recall, Sleep
Consolidation). The most influential single source on our retrieval
shape.
- **Push Pack** pattern — proactive Task State + hot-tail + time markers
  bundle (`pushPack()` in `src/memory/index.ts:1400`)
- **Importance log-modulation** in scoring — the v12 formula
  `effective = cos_sim × (1 + α·log(importance))`, α≈0.15
- **MMR / dialog diversity** for top-K reshuffling
  (`applyDialogDiversity()` + `LOTL_MEMORY_MMR=session`)
- **LRU-K-flavored eviction** with type weighting
  (`runEvictionPass()` in `src/memory/decay.ts:135`)
- **Importance components** that informed our category + length
  heuristic (full 4-component scoring is queued for v17)

**Hindsight** (architectural target, source-unconfirmed) — the
LongMemEval SOTA we benchmark against (91.4% R@5). Their published
4-parallel-path recipe is documented in our `docs/EVAL.md` SOTA table.
We adopted the **post-retrieval `reflect` synthesis** pattern: one LLM
call after top-K retrieval that reasons across the recovered memories
before the agent answers. Implemented as `memoryReflect()` in
`src/memory/index.ts:1255`. We have not been able to locate an open-
source repo for Hindsight — if you know the canonical link, please
open an issue.

[**Generative Agents** (Park et al. 2023)](https://arxiv.org/abs/2304.03442) —
periodic reflection over stored memory streams. We run this as
`runReflectionPass()` (`src/memory/index.ts:1306`) — pulls the last N
memories, derives meta-reflections via LLM, stores them as new memories
with `category=reflection`. Wired into the OpenClaw `session_end` hook.

### Algorithms & classic IR

- **BM25** (Robertson, Jones et al. — Okapi BM25) — keyword search via
  SQLite FTS5. `bm25()` ranking from FTS5's built-in implementation.
- **Reciprocal Rank Fusion** (Cormack, Clarke, Büttcher 2009) — our
  `RRF_K=60` smoothing constant fuses the BM25 + vector ranked lists.
  Two-list RRF with 2× weight on the BM25 list.
- **Maximal Marginal Relevance** (Carbonell & Goldstein 1998) — the
  diversity primitive behind `applyDialogDiversity`. We use a
  session-key variant instead of cosine similarity — cheaper, attacks
  the multi-evidence retrieval pattern directly.
- **LRU-K** (O'Neil, O'Neil, Weikum 1993, SIGMOD) — the eviction policy
  Tinkerclaw cites and we approximate with a single-field backward
  window in `runEvictionPass`.
- **Weibull distribution** — the decay curve shape for memory
  forgetting, fitted per tier in `src/memory/decay.ts:16`.
- **HNSW** indirectly via [**sqlite-vec**](https://github.com/asg017/sqlite-vec) —
  vector index. We use vec0 virtual tables with PARTITION KEY for
  per-scope KNN.

### Tooling & infrastructure

- [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) —
  synchronous SQLite bindings. The reason Lotl can stay zero-async at
  the storage layer.
- [**sqlite-vec**](https://github.com/asg017/sqlite-vec) — Alex Garcia's
  vector extension. Cosine, partition keys, the whole vector pipeline.
- [**@huggingface/transformers**](https://github.com/huggingface/transformers.js) —
  the rebranded `@xenova/transformers`. Local ONNX embed backend
  (default: `mixedbread-ai/mxbai-embed-xsmall-v1` q8, confirmed at
  n=500 LongMemEval after the Phase 11.8 sweep on 2026-04-18; Snowflake
  arctic-embed-s was briefly a candidate but lost to mxbai-xs after
  the metric audit).
- [**tree-sitter**](https://github.com/tree-sitter/tree-sitter) +
  language grammars — AST-aware code chunking for TS/JS/Python/Go/Rust.
- [**Model Context Protocol**](https://github.com/modelcontextprotocol/specification) —
  the MCP transport for the `lotl mcp` server.
- [**OpenClaw**](https://docs.claude.com/en/docs/claude-code/openclaw) —
  the agent integration framework whose hook system Lotl plugs into.

### Benchmarks we honor

- [**LongMemEval**](https://github.com/xiaowu0162/LongMemEval) — Wu et
  al.'s 500-question multi-session retrieval benchmark. Our headline
  metric. Per-category breakdown (single-session-user / -assistant /
  -preference, knowledge-update, temporal-reasoning, **multi-session**)
  is the lens we use to find ranking failures.
- [**LoCoMo**](https://github.com/snap-research/locomo) — Snap
  Research's long-context memory benchmark. We use conv-26 + conv-30
  (n=304) for stress testing question-answer quality, with the
  [LoCoMo audit](https://github.com/dial481/locomo-audit)'s 6.4%
  ground-truth caveat applied.

### What we built different (the QMD-specific bits)

- **One database for everything.** Documents, memories, knowledge graph,
  vectors, FTS5, decay scores, embedding cache — all in a single
  `~/.cache/lotl/index.sqlite`. No ChromaDB, no LanceDB, no separate
  vector store, no Redis.
- **Zero-LLM-first.** Every search-quality improvement that doesn't need
  an API call ships before any that does. LLM rerank, query expansion,
  and reflection synthesis are all opt-in enhancements.
- **Remote-first dispatch with optional local embed.** When cloud
  providers are configured, they take priority. Local embed via
  `LOTL_EMBED_BACKEND=transformers` is opt-in — no cmake, no GPU
  required for the default install.
- **Scope = partition key.** `memories_vec` ships with `scope TEXT
  PARTITION KEY` so vector KNN walks only the current scope's slice of
  the index. Eliminated the n=500 89.4% R@5 ceiling caused by global
  KNN bleeding across scopes.
- **Adaptive cosine acceptance.** `pickVectorMatches` replaces the
  legacy fixed 0.3 floor with `max(absFloor=0.05, top1 × 0.5)` and a
  `minKeep=5` safety net. Survives both open-vault and focused-
  haystack regimes.
- **Multi-query expansion (zero-LLM).** Two variants:
  `LOTL_MEMORY_EXPAND=entities` (proper nouns) and
  `LOTL_MEMORY_EXPAND=keywords` (top-N keyword groups). The keyword
  variant gave +1pp multi-session R@5 on LongMemEval n=500 in our
  2026-04-13/14 night cycle.
- **Compact local provider footprint.** No `node-llama-cpp`, no `cmake`
  builds, no fastembed enum. Single ONNX backend that accepts any HF
  repo via env vars.

---

## From v0 to v1.0 — the origin story + metrics journey

**How Lotl started.** Two weeks before this release (my first fork commit is `2026-04-04`), I was running [tobi/qmd](https://github.com/tobilu/qmd) (a local BM25+vector markdown search CLI) alongside [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) for agent memory — and the mismatch between the two databases constantly bit me. Two separate stores, two separate ingest paths, two different query APIs, syncing by hand. I forked qmd because it was the easiest codebase to get running and modify, and set out to merge the memory layer into the same SQLite file.

That "just get them to sync cleanly" goal turned into a rabbit hole. The first attempts at a proper memory framework on top of qmd **didn't work** — recall was bad, decay was wrong, extraction produced garbage. That failure sent me into the research literature (LongMemEval, LoCoMo, Mem0, Hindsight, MemPalace, MemGPT, GraphRAG), and each paper changed a piece of the design. Every version below is my fork — **not upstream tobi/qmd** — evolving the memory layer while keeping the hybrid-search core qmd was already good at.

Two weeks later (2026-04-04 → 2026-04-18), the result was unrecognizable from the starting point. Hence the rename to Lotl.

**Why rename instead of staying `qmd`.** Tobi's `qmd` is a carefully-designed, focused search CLI — small, deliberate, well-scoped. What I built is the opposite: a vibe-coded rabbit hole, shipped fast, that ended up as a memory framework with its own opinions. Calling my fork `qmd` would have (a) risked confusing users about who authored what, and (b) attached my experimental, research-driven work to tobi's proper project in a way that doesn't honor the difference. Renaming to **Lotl** makes the boundary clean: tobi keeps `qmd` as the tight search-CLI he designed; this fork gets its own identity for its own trade-offs. Not stealing, not competing — just not squatting on his name.

### Version history (all on my fork, after branching from tobi/qmd)

| Version | Date | Configuration | rAny@5 | MRR | pref MRR | What changed |
|---|---|---|---|---|---|---|
| tobi/qmd upstream | 2025-12-07 onwards | BM25 + vector + RRF + rerank CLI, sqlite-vec, MCP server, no memory layer | — | — | — | Tobi Lutke's original. My fork branches off this. |
| fork v0 (cloud + rebrand) | 2026-04-04 → 04-08 | + ZeroEntropy cloud LLM config, per-op remote dispatch, `@tanarchy/qmd` rebrand | — | — | — | First David commits. Still mostly tobi's shape + minor cloud plumbing |
| fork v1 | 2026-04-09 → 04-12 | FTS AND, no memory vectors — first naive memory attempt | — | — | — | Baseline LoCoMo F1=8%. Tried to add memory by intuition; didn't work |
| fork v2 | 2026-04-12 | FTS OR + stopwords + sqlite-vec for memory | — | — | — | F1=22.5%, EM=6%. First usable recall |
| fork v3 | 2026-04-12 | + ZeroEntropy rerank + date-reasoning prompt | — | — | — | F1=27.7% |
| fork v4–v6 | 2026-04-13 | + query expansion + KG triples + adversarial-fix | — | — | — | F1=49–51%, EM=30%. Mem0 paper changed extraction |
| fork v7–v8 | 2026-04-13 | + decay + strong-signal, then rip KG-in-recall (regressed R@5) | — | — | — | F1=53%, then R@5=38.7%/F1=49.5% after KG-rip |
| fork v10 | 2026-04-11 | Mem0-style LLM fact extraction + KG auto-pop | **59.0%**¹ | — | — | conv-30 F1=54.3%, EM=34.3% |
| fork v11–v16 | 2026-04-13 → 04-17 | RRF pipeline + keyword expansion + synonym expansion | 96.6 → 98.4% | 0.88 → 0.917 | 0.72 → 0.745 | LongMemEval era. Phase 1–7 sweeps |
| fork v17 (pre-rename) | 2026-04-17 | n=500 validated best-config | 98.4% | 0.917 | 0.745 | Last version under the `qmd` name |
| **Lotl v1.0** | 2026-04-18 | n=500 sweep of 5 embedders, honest-eval harness, LoCoMo Judge-Acc | **98.4%** | **0.917** | **0.745** | mxbai-xs q8 confirmed as permanent default. Renamed |

¹ LoCoMo conv-30, 105Q sample

**LoCoMo end-to-end at v1.0** (10 convs, 1986 QA, gemini-2.5-flash gen+judge): **81.4% Judge-Acc**. Competitive with published LoCoMo claims (Mem0 91.6% on GPT-4-class, Hindsight 89.6%/83.6%). See [`evaluate/SNAPSHOTS.md`](evaluate/SNAPSHOTS.md) for reproduction recipes.

## What we learned about `R@5` — a metric-collision story

One sentence: **most memory-framework "R@5" claims are not apples-to-apples**.

Three metrics all get called "R@5":

| Name | Definition | Who publishes this |
|---|---|---|
| `recall_any@5` | 1 if ANY gold session appears in top-5, else 0 | agentmemory, Mem0, MemPalace |
| `R@5` (fractional) | `(gold sessions in top-5) / (total gold sessions)` | LongMemEval paper (ICLR 2025) |
| `session_recall@5` ("sr5") | Set-membership on unique session IDs | our original metric pre-audit |

For a question with 3 gold sessions where top-5 contains 2:
- `recall_any@5` = 1.0
- `R@5` (fractional) = 0.667
- `sr5` = 1.0 (same as recall_any@5 modulo duplicates)

**Before the audit** we compared our `sr5` against MemPalace's `R@5` label and thought we were 7pp behind. **After the audit** we realized MemPalace's 96.6% "R@5" is actually `recall_any@5`, and ours was already 98.4% — we were *ahead*, not behind. Six hours of chasing a fake gap.

Lessons that shaped Lotl's eval:

1. **Always report the metric *name* AND *definition*.** `evaluate/SNAPSHOTS.md` logs both.
2. **Report all three** when comparing — `recall_any@5` for Mem0/MemPalace parity, `R@5` (fractional) for LongMemEval paper parity, `MRR`/`NDCG@10` for ranking-quality signal.
3. **top-k must be < max sessions per conv.** Publishing "100% recall" with `top_k=50` on conversations that have ≤32 sessions is a whole-conversation leak (MemPalace admitted this in their own BENCHMARKS.md). Lotl caps LLM context at top-k=10 (Mem0 paper default) regardless of retrieval-pool size.
4. **Preference MRR is the metric that matters for a memory system.** rAny@5 and overall MRR can stay high while single-session-preference collapses. In our Phase 11.8 sweep, all 4 challengers (gte-small, bge-large, UAE-Large, jina-v5) tied or beat mxbai-xs on overall MRR, but *all regressed on preference MRR* — which is why mxbai-xs stays the default.
5. **Generator-bound vs retriever-bound Judge-Acc.** Of our 500 LongMemEval questions, 86% had the correct session in top-5 — but 67.7% of those got a wrong answer from gemini-2.5-flash (it hedges instead of committing to retrieved facts). Phase 7 measured 64% Judge-Acc with gpt-4o on the same retrieval layer. Lotl's retrieval doesn't need fixing; the generator choice dominates the end-to-end score.

Full audit at [`evaluate/locomo/HYBRID_HARNESS.md`](evaluate/locomo/HYBRID_HARNESS.md) and the competitor methodology table in [`evaluate/CLEANUP_PLAN.md`](evaluate/CLEANUP_PLAN.md).

## Acknowledgments — papers + frameworks we learned from

Lotl stands on a lot of shoulders. This list is not exhaustive and reflects what moved the needle for v1.0.

### Origin

- **[tobi/qmd](https://github.com/tobilu/qmd)** — the upstream project I forked in January 2026. Tobi's qmd was "Quick Markdown" — a local BM25+vector search CLI for notes, opt-in local ONNX embeddings, no memory layer. It's a clean, small codebase and that's exactly why it was the right place to start: easy to read, easy to modify, and I didn't have to fight a framework to bolt memory onto it. The BM25+vector+RRF foundation, the sqlite-vec integration, the MCP server scaffolding, and the zero-setup install story are all tobi's. Lotl would not exist without qmd to fork.

### The rabbit hole

- **[memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)** — the agent-memory plugin I was running alongside tobi/qmd when I hit the two-database problem that started all of this. Their admission-control pattern, decay-after-ingest flow, and OpenClaw plugin shape all made it into Lotl. The original goal was literally just "make qmd and memory-lancedb-pro not feel like two separate worlds" — that goal expanded into a rewrite of the memory layer on qmd's SQLite. So: every architecture decision in `src/memory/` either adopts or deliberately diverges from memory-lancedb-pro.

### The development fork (my v0)

- **My own fork of qmd, 2026-04-04 → 2026-04-18.** Everything in the version table above (fork v0 onward) is my fork, not upstream tobi/qmd. Dates come from `git log`: my first commit on this tree is 2026-04-04 ("feat: add cloud LLM support with ZeroEntropy"); the Lotl v1.0 rename is 2026-04-18 — **exactly two weeks of work**. Early iterations (fork v1–v8) in that window were my own failed attempts at adding a memory framework by intuition alone. It didn't work — recall was poor, extraction produced noise, decay was wrong. That failure made me sit down and read the research literature (below). Every version from v10 onward explicitly takes technique from a specific paper or framework. The BM25+vector+RRF+rerank search pipeline stays close to tobi's original shape; the memory system, KG, decay engine, extraction, honest-eval harness, and metric discipline were written from scratch in the last six of those fourteen days. **Lotl is qmd-forked with most of the memory code written from scratch**, renamed because the result is no longer "qmd with memory" — it's a different project.

### Papers

- **LongMemEval** — *"Benchmarking Chat Assistants on Long-Term Interactive Memory"* (Wu et al., ICLR 2025, arXiv:2410.10813). Canonical benchmark; the `R@5` (fractional) definition used across all retrieval claims; the 6000-char per-memory cap in Phase 7 came from reading their eval harness carefully.
- **LoCoMo** — *"Evaluating Very Long-Term Conversational Memory of LLM Agents"* (Maharana et al., Snap Research). Dataset + stemmed-F1 scoring that we still report alongside LLM-Judge.
- **Mem0** — *"Building Production-Ready AI Agents with Scalable Long-Term Memory"* (arXiv:2504.19413). LLM conflict-resolution (ADD/UPDATE/DELETE/NONE), the "generous topic-match" judge prompt ported into Lotl's honest-harness, the fact-extraction + entity-triple combined prompt in `src/memory/extractor.ts`.
- **Hindsight** — *"Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects"* (arXiv:2512.12818). TEMPR 4-way retrieval inspired our RRF hybrid; the token-budgets-not-raw-top-k framing shaped our top-k=10 LLM-context decision.
- **FACTS Grounding** (Google DeepMind). Benchmark that identified gemini-3.1-pro as the strongest generator for hallucination-resistant answers — directly informs the LLM recommendations in `evaluate/SNAPSHOTS.md`.
- **MemGPT / Letta**. Two-tier recall + archival-memory pattern. Lotl's Weibull decay + three-tier promotion (peripheral → working → core) shares the same philosophical ancestry.
- **GraphRAG** (Microsoft Research). Community-summaries approach for graph-augmented retrieval — influenced the `knowledge_*` MCP tools' subject-predicate-object design.
- **Vannevar Bush's "As We May Think"** (Atlantic Monthly, 1945). Coined `memex` = MEMory EXtender, proto-ancestor of every personal knowledge system since. Lotl's architecture is literally what Bush described 80 years ago: associative trails through indexed records.

### Frameworks

- **[MemPalace](https://github.com/MemPalace/mempalace)** — Ported their zero-LLM boost patterns: keyword-overlap multiplier, quoted-phrase boost, person-name filtering/boost. We also publicly disagreed with their top-k=50 whole-conversation-leak (credit to their own `BENCHMARKS.md` for admitting it first).
- **[memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)** — Reference for OpenClaw plugin integration (hooks, config schema, install flow). Their admission-control + decay-after-ingest pattern informed `src/memory/decay.ts`.
- **[Mastra](https://github.com/mastra-ai/mastra)** — Observational memory architecture (3-agent background compression). Their public refusal to publish LoCoMo numbers (citing the metric ambiguity we later hit ourselves) shaped our insistence on reporting *definitions* alongside scores.
- **[Zep / Graphiti](https://github.com/getzep/graphiti)** — Three-tier subgraph pattern informed our temporal knowledge graph with `valid_from` / `valid_until` windows in `src/memory/knowledge.ts`.
- **Tinkerclaw** — Identity model + Instant Recall 4-component score (entity_density + decision + engagement + recency). Lotl's `entityDensity` + `hasDecisionSignal` in `src/memory/extractor.ts` are direct ports (minus the engagement component, which duplicated our length heuristic).
- **[snap-research/locomo](https://github.com/snap-research/locomo)** — Canonical LoCoMo scoring (stemmed F1, adversarial special-casing) reimplemented in `evaluate/locomo/eval.mts`.

### Infrastructure

- **[`@huggingface/transformers`](https://github.com/huggingface/transformers.js)** (the JS port). Every local embed + rerank path goes through this; the direct-ORT backend's tokenizer (`AutoTokenizer`) lives here.
- **[sqlite-vec](https://github.com/asg017/sqlite-vec)** by Alex Garcia. Partition-key vector virtual table made scope-aware KNN possible in a single SQLite file.
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)**. Synchronous SQLite binding; the foundation everything else sits on.
- **[OpenClaw](https://openclaw.io/)**. Plugin SDK we integrate with via the `tanarchy-lotl` plugin manifest.
- **[ZeroEntropy](https://zeroentropy.dev/)**, **[SiliconFlow](https://siliconflow.com/)**, **[Nebius Studio](https://studio.nebius.ai/)**. Remote embed/rerank providers that provide the production cost/quality tradeoff qmd/Lotl has always been tuned against.

If you'd like an attribution added or corrected, please open an issue.

## License

MIT