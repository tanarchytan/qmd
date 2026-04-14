# QMD — Search + Memory for AI Agents

A unified search engine and memory system for AI agents. Index your documents, store conversation memories, track knowledge — all in one SQLite database.

**Document search:** BM25 + vector + RRF fusion + LLM reranking across markdown, code, and notes.
**Agent memory:** Store, recall, forget, and extract memories with automatic deduplication and decay.
**Knowledge graph:** Temporal entity-relationship triples — "what was true when?"

Runs against cloud APIs (ZeroEntropy, SiliconFlow, Nebius, Gemini, OpenAI) by default — no cmake, no GPU required. Set `QMD_EMBED_BACKEND=transformers` to opt in to local ONNX embeddings via `@huggingface/transformers`.

```sh
npm install -g @tanarchy/qmd
```

## Quick Start

```sh
# Index your documents
qmd collection add ~/notes --name notes
qmd collection add ~/work/docs --name docs
qmd context add qmd://notes/ "Personal notes and ideas"
qmd context add qmd://docs/ "Work documentation"
qmd embed

# Search
qmd search "project timeline"           # BM25 keyword search
qmd vsearch "how to deploy"             # Vector semantic search
qmd query "quarterly planning process"  # Hybrid + reranking (best quality)

# Get documents
qmd get "docs/api-reference.md"
qmd get "#abc123"                        # by docid
qmd multi-get "journals/2025-05*.md"     # by glob pattern
```

## MCP Server

QMD exposes all functionality via MCP (Model Context Protocol). Works with Claude Desktop, Claude Code, Cursor, OpenClaw, and any MCP client.

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
| `memory_store` | Store a memory with auto-dedup (hash + cosine) and auto-classification |
| `memory_recall` | Hybrid search across memories (FTS + vector + keyword boost + decay weighting) |
| `memory_forget` | Delete a memory (with changelog) |
| `memory_update` | Update text/importance/category (re-embeds on text change) |
| `memory_extract` | Extract memories from conversation text (heuristic pattern matching) |
| `memory_stats` | Memory count by tier, category, scope |

### Knowledge tools
| Tool | Description |
|------|-------------|
| `knowledge_store` | Store a fact with time validity (auto-invalidates conflicting prior facts) |
| `knowledge_query` | Query facts by subject/predicate/object, optionally at a point in time |
| `knowledge_invalidate` | Mark a fact as no longer valid (preserved in history) |
| `knowledge_entities` | List all known entities |

### Management tools
| Tool | Description |
|------|-------------|
| `manage` | Administrative ops: `embed`, `update`, `cleanup`, `sync`, `decay` |

### Setup

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

**Claude Code:**
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

**HTTP transport** (shared daemon, models stay loaded):
```sh
qmd mcp --http --daemon           # start on localhost:8181
qmd mcp stop                      # stop
```

## Cloud Configuration

Copy `.env.example` to `~/.config/qmd/.env`. Loaded automatically.

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
QMD_EMBED_PROVIDER=zeroentropy
QMD_EMBED_API_KEY=ze_your-key
QMD_EMBED_MODEL=zembed-1
QMD_RERANK_PROVIDER=zeroentropy
QMD_RERANK_API_KEY=ze_your-key
QMD_RERANK_MODEL=zerank-2
QMD_RERANK_MODE=rerank
QMD_QUERY_EXPANSION_PROVIDER=api
QMD_QUERY_EXPANSION_API_KEY=nebius-key
QMD_QUERY_EXPANSION_URL=https://api.studio.nebius.ai/v1
QMD_QUERY_EXPANSION_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct
```

### Example: SiliconFlow all three operations

```sh
QMD_EMBED_PROVIDER=siliconflow
QMD_EMBED_API_KEY=sk-your-key
QMD_EMBED_MODEL=Qwen/Qwen3-Embedding-8B
QMD_RERANK_PROVIDER=siliconflow
QMD_RERANK_API_KEY=sk-your-key
QMD_RERANK_MODEL=BAAI/bge-reranker-v2-m3
QMD_RERANK_MODE=rerank
QMD_QUERY_EXPANSION_PROVIDER=siliconflow
QMD_QUERY_EXPANSION_API_KEY=sk-your-key
QMD_QUERY_EXPANSION_MODEL=zai-org/GLM-4.5-Air
```

Embed can also run locally via `QMD_EMBED_BACKEND=transformers` (ONNX, opt-in). Rerank and query expansion are remote-only.

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
              BM25 lists: 2× weight
              Vector lists: 1× weight
                      │
                      ▼
           Zero-LLM Score Boosts
           • keyword overlap (+30%)
           • quoted phrase match (+60%)
           • person name match (+40%)
           • stop word filtering
                      │
                      ▼
              LLM Reranking
              (ZeroEntropy / local Qwen3)
                      │
                      ▼
           Position-Aware Blend
           Rank 1-3:  75% RRF / 25% reranker
           Rank 4-10: 60% / 40%
           Rank 11+:  40% / 60%
                      │
                      ▼
              Final Results
```

All scoring parameters are env-configurable. See `.env.example`.

## CLI Reference

```sh
# Collections
qmd collection add <path> --name <name>
qmd collection list
qmd collection remove <name>
qmd collection rename <old> <new>
qmd ls [collection[/path]]

# Context
qmd context add [path] "description"
qmd context list
qmd context check
qmd context rm <path>

# Search
qmd search <query>              # BM25 keyword search
qmd vsearch <query>             # Vector similarity search
qmd query <query>               # Hybrid + reranking (best quality)

# Retrieval
qmd get <file>                  # by path or docid (#abc123)
qmd multi-get <pattern>         # by glob or comma-separated list

# Indexing
qmd embed                       # generate vector embeddings
qmd embed --force               # re-embed everything
qmd update                      # re-index all collections
qmd sync                        # update + embed in one command

# Maintenance
qmd status                      # index status + remote providers
qmd cleanup                     # clear cache + orphans + vacuum
qmd vacuum                      # reclaim DB space

# MCP
qmd mcp                         # stdio transport
qmd mcp --http [--port N]       # HTTP transport
qmd mcp --http --daemon         # background daemon
qmd mcp stop                    # stop daemon
```

## SDK Usage

```typescript
import { createStore } from '@tanarchy/qmd'

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
npx tsx src/cli/qmd.ts <command>   # Run CLI from source (dev mode)
npm link                            # Install globally as 'qmd'
npx vitest run test/                # Run tests
npm run build                       # Compile TypeScript to dist/
npm run typecheck                   # tsc --noEmit (no emit, just type-check)
```

Node.js ≥22 required. Bun support was dropped — all code is Node-only.

## Benchmarks

QMD ships a **local-first, zero-cost benchmark loop** that matches MemPalace's setup exactly: local ONNX embeddings via `fastembed`, no API keys, deterministic. The cost discipline is "iterate locally with `--no-llm`, validate answer quality with one paid Gemini run at the end." A full `longmemeval_s_cleaned` n=500 retrieval pass costs **$0** and runs in ~25 min on a laptop.

**Primary metrics: R@5 / R@10 (token-overlap recall), MRR (rank quality), F1 / EM / SH (answer quality).** These actually discriminate pipeline changes. MemPalace-style session recall (SR@K) and dialog recall (DR@K) are reported as secondary reference rows; they're ceilinged or near-ceilinged on these datasets and should be taken with a grain of salt (see caveats below).

### LongMemEval _s_cleaned — the headline benchmark (500 questions × ~50 distractor sessions)

| Pipeline | n | R@5 | R@10 | F1 | EM | Cost | Time |
|---|---|---|---|---|---|---|---|
| **MemPalace raw + fastembed** (their published run) | 500 | **96.6%** | 98.2% | — | — | $0 | 12.5m |
| **QMD raw + fastembed + scope-partitioned vec0** | 500 | **93.2%** | **95.2%** | — | — | $0 | 24m |
| QMD raw + fastembed + adaptive cosine (n=100 first slice) | 100 | 97.0% | 97.0% | 64.9% | 48.0% | $0 | 5m |

Same embed model (`all-MiniLM-L6-v2`, 384-dim ONNX). Same dataset. Zero API keys for retrieval. Deterministic. QMD additionally measures end-to-end answer quality (F1/EM/SH) that MemPalace's benchmark doesn't produce — their 96.6% is retrieval-only.

**Per-category performance** on full n=500 (pre-fix baseline — illustrates how diagnostic the per-category split is):

| Category | n | QMD R@5 | MemPalace R@5 | Δ |
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
2. **K-multiplier bump** (`QMD_VEC_K_MULTIPLIER=20`) — workaround that fetches K=1000 vec hits instead of K=150, so the post-vector scope filter has enough candidates per scope to fill top-50. Architecturally proper fix (a `scope` partition key on `memories_vec`) is queued as a separate schema-migration commit.

n=500 rerun with both fixes is in flight at session-close.

### LongMemEval oracle (n=200, pre-filtered haystack)

| Pipeline | R@5 | R@10 | F1 | EM | SR@5 (MP-compat) |
|---|---|---|---|---|---|
| QMD v15.1 | **87.0%** | **93.0%** | **50.6%** | 27.5% | 100% ceiling |
| QMD v16.1 (reflect augment) | 84.5% | 91.5% | 49.4% | 27.0% | 100% |
| **MemPalace (own benchmark)** | **100%** | **100%** | — | — | 100% ceiling |

Oracle is pre-filtered to relevant sessions — SR@K hits 100% by construction for any retriever. Use the `_s_cleaned` row above for a meaningful comparison.

### LoCoMo conv-26 + conv-30 (n=304)

| Pipeline | R@5 | R@10 | F1 | EM | DR@50 (MP-compat) |
|---|---|---|---|---|---|
| QMD v15-final | — | — | 60.9% | 38.6% | — |
| QMD v15.1 | 50.0% | 60.9% | **58.6%** | 36.2% | **74.9%** |
| QMD v16 (diversity only) | **50.9%** | **60.9%** | 58.9% | 37.2% | 75.7% |
| **MemPalace (own benchmark)** | — | — | — | — | **74.8%** |

Single-conv breakdowns and v16.1 (reflect augment) detail live in [`docs/ROADMAP.md`](docs/ROADMAP.md).

**What this says:**

- On the one metric where both sides cleanly discriminate — **LoCoMo dialog-level DR@50** — QMD v15.1 matches MemPalace's own benchmark to within 0.1pp (74.9 vs 74.8). Parity on their metric with their own pipeline.
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
QMD_EMBED_BACKEND=fastembed \
QMD_RECALL_RAW=on \
QMD_INGEST_EXTRACTION=off QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off \
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

This project builds on ideas from several remarkable open-source projects:

### [tobi/qmd](https://github.com/tobi/qmd) — The Foundation
The original QMD by Tobi Lutke. Everything starts here: SQLite FTS5 + sqlite-vec hybrid search, node-llama-cpp local LLM pipeline, AST-aware chunking via tree-sitter, the MCP server, session management, and the entire CLI. We forked this and built on top.

### [MemPalace](https://github.com/milla-jovovich/mempalace) — Search Quality Breakthroughs
Their benchmark work changed how we think about retrieval. Key lessons:
- **Raw verbatim storage beats LLM extraction** (96.6% recall with zero LLM calls vs Mem0's 30-45%)
- **Zero-LLM score boosts**: keyword overlap (+1.2%), quoted phrase matching (+0.6%), person name boosting (+0.6%), preference pattern extraction (+0.6%) — all implemented in our search pipeline
- **Stop word list** for keyword extraction precision
- **Temporal knowledge graph** with validity windows — our `knowledge_store`/`knowledge_query` is directly inspired by their approach
- Their honest benchmarking methodology (500-question LongMemEval, per-category breakdowns) set the standard

### [Mem0](https://github.com/mem0ai/mem0) — Memory Architecture Patterns
52k stars and a clean architecture. What we learned:
- **Two-layer deduplication**: content hash (instant) + cosine similarity (semantic) — implemented in `memory_store`
- **Memory changelog table** for audit trails ("why does the agent believe X?")
- **Three-tier scope model** (user/session/agent) — informed our `scope` field design
- **LLM conflict resolution** (ADD/UPDATE/DELETE/NONE) — design pattern for future enhancement
- **OpenClaw plugin pattern** — their `@mem0/openclaw-mem0` plugin is the reference for our Phase 5

### [Mastra](https://github.com/mastra-ai/mastra) — Memory Processing
TypeScript AI framework with sophisticated memory management:
- **Observational memory** — three-agent (actor/observer/reflector) background compression of conversations
- **Embedding LRU cache** keyed by xxhash64 — avoiding re-embedding identical queries
- **Token budgeting** with dual thresholds for context window management
- **Thread/resource isolation** — informed our per-scope memory boundaries

### [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) — Decay & Lifecycle
OpenClaw plugin with the most complete memory lifecycle:
- **Weibull decay engine** — the exact formula (recency × frequency × intrinsic) with tier-specific beta values is ported directly
- **Three-tier promotion** (Peripheral → Working → Core) with access-count thresholds
- **Smart extraction** with 6 categories — our category system matches theirs
- **Auto-capture/recall hooks** for OpenClaw — the reference architecture for Phase 5

### What We Built Different
- **One database** — everything in SQLite (documents, memories, knowledge, vectors, FTS, cache). No ChromaDB, no LanceDB, no separate vector store.
- **Zero-LLM-first** — search quality improvements that don't require API calls (score boosts, stop words, pattern matching). LLM reranking is optional enhancement, not a requirement.
- **Remote-first dispatch** — when cloud providers are configured, they take priority with automatic fallback to local. No cmake builds needed for remote-only setups.

## License

MIT