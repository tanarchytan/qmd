# QMD — Search + Memory for AI Agents

A unified search engine and memory system for AI agents. Index your documents, store conversation memories, track knowledge — all in one SQLite database.

**Document search:** BM25 + vector + RRF fusion + LLM reranking across markdown, code, and notes.
**Agent memory:** Store, recall, forget, and extract memories with automatic deduplication and decay.
**Knowledge graph:** Temporal entity-relationship triples — "what was true when?"

Runs locally (GGUF models, no cloud needed) or via cloud APIs (ZeroEntropy, SiliconFlow, Nebius, Gemini, OpenAI). Set `QMD_LOCAL=no` for remote-only mode — no cmake, no GPU required.

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
QMD_LOCAL=no
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
QMD_LOCAL=no
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

When no remote providers are configured, QMD uses local GGUF models automatically. You can mix local and remote (e.g. local embeddings + cloud rerank).

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

QMD's memory system is evaluated against two long-term memory benchmarks, with recall measured apples-to-apples against MemPalace's `compute_retrieval_recall` (session-id and dialog-id match, not token-overlap):

| Benchmark | Tests | QMD v15.1 |
|-----------|-------|-----------|
| **LongMemEval oracle** (n=50, temporal-reasoning subset) | Information-retrieval memory across many sessions | **SR@5 = 100.0%** · F1 52.9% · EM 28.0% |
| **LoCoMo** (conv-26 + conv-30) | Conversational memory across 35-session dialogues | F1 60.9% / EM 38.6% (v15-final cross-conv avg; v15.1 DR@K re-run in progress) |

**Apples-to-apples caveats**
- `SR@K` = MemPalace `recall_any`: did any top-K memory come from a session listed in the QA's evidence? Directly comparable to their published 96.6% LongMemEval R@5.
- `DR@K` = MemPalace `compute_retrieval_recall`: fraction of evidence dialog IDs appearing in top-K (LoCoMo only, since LongMemEval has no dialog IDs).
- The earlier v15-final "80% R@5" was a legacy token-overlap metric that fails on short numeric answers ("27" vs "27 years old" scored 0). SR@5 re-measurement shows retrieval was already at ceiling on the temporal-reasoning subset.
- LongMemEval numbers are on a temporal-reasoning-only subset (dataset-order artifact from `--limit 50`). A `--limit 200` mixed-category run is the next step before calling any number representative.

Reference SOTA on LongMemEval (per [vectorize.io memory survey](https://vectorize.io/articles/best-ai-agent-memory-systems)):
- Hindsight 91.4% · SuperMemory 81.6% · Zep 63.8% · Mem0 49.0%

See [`docs/EVAL.md`](docs/EVAL.md) for the eval methodology, env-var ablation toggles, parallel sharding, and reproducibility notes. Full version history, technique tables, lessons learned, and SOTA targets in [`docs/ROADMAP.md`](docs/ROADMAP.md).

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