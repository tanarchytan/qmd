# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package

`@tanarchy/qmd` — on-device hybrid search for markdown files with BM25, vector search, and LLM reranking. Plus a memory system with decay, knowledge graph, and OpenClaw integration.

Repo: `github.com/tanarchytan/qmd` — `main` (stable) + `dev` (active development).

## Build & Development

```sh
bun install                        # Install dependencies (prefer Bun over npm)
npm run build                      # tsc -p tsconfig.build.json → dist/
npm run typecheck                  # tsc --noEmit (no emit, just type-check)
bun src/cli/qmd.ts <command>       # Run CLI from source (dev mode)
bun link                           # Install globally as 'qmd'
```

**Never run `bun build --compile`** — it overwrites the shell wrapper (`bin/qmd`) and breaks sqlite-vec. The `qmd` binary is a shell script that dispatches to `dist/cli/qmd.js`.

## Tests

Framework: Vitest. All tests in `test/`. Timeout: 30s.

```sh
npx vitest run --reporter=verbose test/             # Run all tests (npm)
npx vitest run --reporter=verbose test/store.test.ts # Run a single test file
bun test --preload ./src/test-preload.ts test/       # Run all tests (Bun)
```

CI runs on Node 22/23, Ubuntu/macOS, both npm and Bun runtimes.

## MCP Inspector

```sh
npm run inspector   # Launches @modelcontextprotocol/inspector against the MCP server
```

## Releasing

Use `/release <version>` to cut a release. Add changelog entries under `## [Unreleased]` in CHANGELOG.md as you make changes — the release script renames it to `[X.Y.Z] - date`. Full details in `skills/release/SKILL.md`.

## Architecture

### Entry points

| Entry | File | Purpose |
|-------|------|---------|
| CLI | `src/cli/qmd.ts` | ~40 commands, main user interface |
| SDK | `src/index.ts` | `createStore()` + typed search/retrieval API |
| MCP | `src/mcp/server.ts` | MCP tools (stdio + HTTP transport) |
| OpenClaw | `src/openclaw/plugin.ts` | Auto-recall/capture hooks for agent frameworks |

### Core modules

- **`src/store.ts`** — The heart of QMD. Document storage, FTS5 indexing, vector search, chunking, RRF fusion, reranking pipeline, memory CRUD. Most search logic lives here.
- **`src/llm.ts`** — LLM abstraction layer. Local models via node-llama-cpp (embeddings: embeddinggemma, reranking: qwen3-reranker, generation: Qwen3). Remote providers: OpenAI-compatible, ZeroEntropy, SiliconFlow, Gemini, Nebius. Lazy-loads models, auto-unloads after 5min inactivity.
- **`src/db.ts`** — better-sqlite3 + sqlite-vec initialization, PRAGMA tuning.
- **`src/collections.ts`** — YAML config parsing, collection CRUD with write-through to both SQLite and YAML.
- **`src/remote-config.ts`** — Per-operation provider configuration builder (`QMD_EMBED_PROVIDER`, `QMD_RERANK_PROVIDER`, `QMD_QUERY_EXPANSION_PROVIDER`).
- **`src/ast.ts`** — AST-aware code chunking via tree-sitter (TS/JS/Python/Go/Rust). Falls back to regex chunking for markdown and unknown types.

### Memory system (`src/memory/`)

- **`index.ts`** — Memory store: FTS5 + sqlite-vec hybrid search, content-hash dedup + cosine dedup (≥0.9), LRU embedding cache.
- **`decay.ts`** — Weibull decay engine: `composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic`. Three-tier promotion (peripheral → working → core).
- **`knowledge.ts`** — Temporal knowledge graph: subject/predicate/object triples with `valid_from`/`valid_until` windows.
- **`patterns.ts`** — 16 regex patterns for zero-LLM memory classification.
- **`extractor.ts`** — Optional LLM-based memory extraction from conversation text.

### Search pipeline

```
Query → BM25 (FTS5) + Vector (sqlite-vec) in parallel
      → RRF Fusion (k=60, 2× BM25 weight)
      → Zero-LLM boosts (keyword overlap, quoted phrases, person names)
      → LLM Reranking (local or remote)
      → Position-aware blend
      → Final results
```

### Data flow

Config (YAML or inline) → `collections.ts` → SQLite `store_collections` table.
Files on disk → `store.ts` reindex → documents table + FTS5 + chunks + sqlite-vec vectors.
Queries flow through `hybridQuery()` or `structuredSearch()` in `store.ts`.

## Environment

Config lives in `~/.config/qmd/.env` (see `.env.example` for all options).
Index stored at `~/.cache/qmd/index.sqlite`.

Key env vars:
- `QMD_LOCAL=no` — skip node-llama-cpp entirely (no cmake, no GPU)
- `QMD_LLAMA_BUILD=auto` — allow cmake builds for node-llama-cpp
- `QMD_EMBED_PROVIDER`, `QMD_RERANK_PROVIDER`, `QMD_QUERY_EXPANSION_PROVIDER` — per-operation remote LLM config

## Commands

```sh
qmd collection add . --name <n>   # Index a directory
qmd collection list               # List collections
qmd collection remove <name>      # Remove collection
qmd collection rename <old> <new> # Rename collection
qmd ls [collection[/path]]        # List files
qmd context add [path] "text"     # Add context for path
qmd context list                  # List contexts
qmd context check                 # Find missing contexts
qmd context rm <path>             # Remove context
qmd get <file>                    # Get doc by path or docid (#abc123)
qmd multi-get <pattern>           # Get multiple docs
qmd status                        # Index status
qmd update [--pull]               # Re-index (--pull: git pull first)
qmd embed                         # Generate embeddings
qmd query <query>                 # Full search (expand + rerank)
qmd search <query>                # BM25 keyword search
qmd vsearch <query>               # Vector similarity search
qmd mcp                           # MCP server (stdio)
qmd mcp --http [--port N]         # MCP server (HTTP)
qmd mcp --http --daemon           # MCP daemon
qmd sync                          # update + embed
qmd vacuum                        # Reclaim space
qmd memory store <text>           # Store memory
qmd memory recall <query>         # Search memories
qmd memory forget <id>            # Delete memory
qmd memory extract <text>         # Extract from conversation
qmd memory stats                  # Memory stats
qmd memory decay                  # Run decay pass
qmd memory import <file>          # Import memories
qmd memory export [file.json]     # Export memories
```

## MCP Tools

Document search: `query`, `get`, `multi_get`, `status`, `briefing`, `manage`
Memory: `memory_store`, `memory_recall`, `memory_forget`, `memory_update`, `memory_extract`, `memory_stats`
Knowledge: `knowledge_store`, `knowledge_query`, `knowledge_invalidate`, `knowledge_entities`

## Important constraints

- **Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically** — write out commands for the user to run
- **Never modify the SQLite database directly** — use the CLI or SDK
- **Never run `bun build --compile`** — breaks the shell wrapper and sqlite-vec
- Node.js ≥22 required
