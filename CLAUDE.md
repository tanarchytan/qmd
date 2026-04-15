# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Where to find docs

Project documentation lives in `docs/`. **Read these before starting non-trivial work:**

- **`docs/ROADMAP.md`** — version history, technique tables, SOTA reference targets, session lessons learned, quality fix tracker, next testing phases. **Always check the latest version + lessons before proposing changes.**
- **`docs/EVAL.md`** — how to run LoCoMo + LongMemEval benchmarks, env-var ablation toggles, parallel sharded runs, reproducibility notes (seed=42, model name pitfalls, cache invalidation).
- **`docs/SYNTAX.md`** — markdown/qmd syntax reference for indexed content.

`CHANGELOG.md` tracks shipped releases. This file (CLAUDE.md) is for code structure and constraints — not benchmark history.

## Package

`@tanarchy/qmd` — on-device hybrid search for markdown files with BM25, vector search, and LLM reranking. Plus a memory system with decay, knowledge graph, and OpenClaw integration.

Repo: `github.com/tanarchytan/qmd` — `main` (stable) + `dev` (active development).
npm: `@tanarchy/qmd` (scope: tanarchy, not tanarchytan).

## Build & Development

```sh
npm install                        # Install dependencies (Node.js only, no Bun)
npm run build                      # tsc -p tsconfig.build.json → dist/
npm run typecheck                  # tsc --noEmit (no emit, just type-check)
npx tsx src/cli/qmd.ts <command>   # Run CLI from source (dev mode)
```

**Never run `bun build --compile`** — it overwrites the shell wrapper (`bin/qmd`) and breaks sqlite-vec. The `qmd` binary is a shell script that dispatches to `dist/cli/qmd.js`.

**Node.js ≥22 required.** Bun support was removed — all code is Node-only with synchronous `createRequire()` in db.ts.

## Tests

Framework: Vitest. All tests in `test/`. Timeout: 30s (CI uses 60s).

```sh
npx vitest run --reporter=verbose test/             # Run all tests
npx vitest run --reporter=verbose test/store.test.ts # Run a single test file
```

CI runs on Node 22/23, Ubuntu/macOS (see `.github/workflows/ci.yml`).

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
| OpenClaw entry | `index.ts` (root) | Re-exports plugin for Jiti loader |

### Core modules

- **`src/store.ts`** — Facade module. Re-exports all public APIs from `src/store/` submodules. External consumers import from `./store.js` — backward compatible.
- **`src/store/`** — Store internals split into submodules:
  - `types.ts` — Shared types (`Store`, `SearchResult`, `DocumentResult`, `CollectionInfo`, etc.)
  - `constants.ts` — Tuning constants (RRF weights, chunk sizes, intent weights, default models)
  - `db-init.ts` — SQLite schema creation, FTS5/sqlite-vec table init, migrations
  - `db.ts` — Thin re-export of `factory.js` and `path.js`
  - `path.ts` — Path resolution, virtual path (`qmd://`) parsing/building, Windows/Git Bash support
  - `collections.ts` — Re-exports collection CRUD from `context.ts`
  - `store-collections.ts` — `store_collections` table CRUD, config-to-DB sync
  - `context.ts` — Collection listing, context retrieval/insertion, path-context queries
  - `documents.ts` — Document CRUD, handelize, docid, content hashing, glob matching
  - `chunking.ts` — Markdown/code chunking with break-point detection, code fence awareness
  - `search.ts` — FTS5 search, vector search, RRF fusion, query expansion, reranking, hybrid/structured search
  - `embeddings.ts` — Collection reindexing, batch embedding generation
  - `maintenance.ts` — Index health, cache, orphan cleanup, vacuum, status
  - `factory.ts` — `createStore()` — assembles a `Store` instance from submodules
- **`src/llm.ts`** — LLM abstraction layer. Local models via node-llama-cpp (lazy-loaded via dynamic `await import()`). Remote providers: OpenAI-compatible, ZeroEntropy, SiliconFlow, Gemini, Nebius. `chatComplete()` method for freeform LLM calls.
- **`src/db.ts`** — better-sqlite3 + sqlite-vec initialization via synchronous `createRequire()`. Zero top-level await (Jiti-safe).
- **`src/collections.ts`** — YAML config parsing, collection CRUD with write-through to both SQLite and YAML.
- **`src/remote-config.ts`** — Per-operation provider configuration builder (`QMD_EMBED_PROVIDER`, `QMD_RERANK_PROVIDER`, `QMD_QUERY_EXPANSION_PROVIDER`). Cached singleton.
- **`src/env.ts`** — Loads QMD config from `~/.config/qmd/.env`. Two-tier precedence: QMD_* env vars from .env override stale parent process vars.
- **`src/ast.ts`** — AST-aware code chunking via tree-sitter (TS/JS/Python/Go/Rust). Falls back to regex chunking for markdown and unknown types.
- **`src/embedded-skills.ts`** — Generated file bundling `skills/qmd/` content. Regenerate when updating packaged skills.

### Memory system (`src/memory/`)

- **`index.ts`** — Memory store: FTS5 + sqlite-vec hybrid search, content-hash dedup + cosine dedup (≥0.9), LLM conflict resolution (ADD/UPDATE/DELETE/NONE via chatComplete), LRU embedding cache.
- **`decay.ts`** — Weibull decay engine: `composite = 0.4×recency + 0.3×frequency + 0.3×intrinsic`. Three-tier promotion (peripheral → working → core).
- **`knowledge.ts`** — Temporal knowledge graph: subject/predicate/object triples with `valid_from`/`valid_until` windows. Scope-aware.
- **`patterns.ts`** — 16 regex patterns for zero-LLM memory classification.
- **`extractor.ts`** — LLM-based memory extraction via chatComplete, with heuristic fallback. Uses dynamic import to break circular dependency.
- **`import.ts`** — Conversation normalization (Claude JSON, ChatGPT JSON, JSONL, plain text) + import/export.

### OpenClaw plugin (`src/openclaw/`)

- **`plugin.ts`** — Registers with OpenClaw via `definePluginEntry()`. Maps openclaw.json config → QMD_* env vars. Hooks: `message_received`, `before_prompt_build`, `agent_end`, `session_end`, `gateway_start`, `after_tool_call`. Per-agent scope auto-detection from sessionKey. Dream consolidation with cursor checkpointing.
- **`openclaw-types.d.ts`** — Type stubs for `openclaw/plugin-sdk` (optional peer dep).
- **`openclaw.plugin.json`** (root) — Plugin manifest with configSchema for autoRecall, autoCapture, embed/rerank/queryExpansion provider config.
- **`index.ts`** (root) — OpenClaw entry point: `export { default } from "./src/openclaw/plugin.js"`

### Setup tooling (`setup/`)

- **`setup-qmd.sh`** — One-click installer: detects OpenClaw, picks provider plan, probes endpoints, writes config (openclaw.json or ~/.config/qmd/.env).
- **`scripts/selfcheck.mjs`** — Probes embed/rerank/expansion endpoints, reports pass/warn/fail.
- **`scripts/config-validate.mjs`** — Validates .env + openclaw.json config.

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
Files on disk → `store/embeddings.ts` reindex → documents table + FTS5 + chunks + sqlite-vec vectors.
Queries flow through `hybridQuery()` or `structuredSearch()` in `store/search.ts`.

## Environment

Config lives in `~/.config/qmd/.env` (see `.env.example` for all options).
Index stored at `~/.cache/qmd/index.sqlite`.

Key env vars:
- `QMD_EMBED_BACKEND=transformers` — opt in to local ONNX embed via `@huggingface/transformers` (default: remote only)
- `QMD_EMBED_PROVIDER`, `QMD_RERANK_PROVIDER`, `QMD_QUERY_EXPANSION_PROVIDER` — per-operation remote LLM config

When running as OpenClaw plugin: provider config lives in `openclaw.json` under `plugins.entries.tanarchy-qmd.config` (embed/rerank/queryExpansion objects). Plugin maps these to QMD_* env vars on register().

## Commands

```sh
qmd collection add . --name <n>       # Index a directory
qmd collection list                   # List collections
qmd collection remove <name>          # Remove collection
qmd collection rename <old> <new>     # Rename collection
qmd collection show <name>            # Show collection details
qmd collection update-cmd <n> [cmd]   # Set pre-index command (e.g. 'git pull')
qmd collection include <name>         # Include in default queries
qmd collection exclude <name>         # Exclude from default queries
qmd ls [collection[/path]]            # List files
qmd context add [path] "text"         # Add context for path
qmd context list                      # List contexts
qmd context check                     # Find missing contexts
qmd context rm <path>                 # Remove context
qmd get <file>                        # Get doc by path or docid (#abc123)
qmd multi-get <pattern>               # Get multiple docs
qmd status                            # Index status
qmd update [--pull]                   # Re-index (--pull: git pull first)
qmd pull                              # Git pull + re-index
qmd embed                             # Generate embeddings
qmd query <query>                     # Full search (expand + rerank)
qmd search <query>                    # BM25 keyword search
qmd vsearch <query>                   # Vector similarity search
qmd mcp                               # MCP server (stdio)
qmd mcp --http [--port N]             # MCP server (HTTP)
qmd mcp --http --daemon               # MCP daemon
qmd mcp stop                          # Stop daemon
qmd sync                              # update + embed
qmd cleanup                           # Remove inactive docs + orphaned content/vectors
qmd vacuum                            # Reclaim space
qmd skill show                        # Show embedded skill
qmd skill install [--global] [--yes]  # Install skill files
qmd memory store <text>               # Store memory
qmd memory recall <query>             # Search memories
qmd memory forget <id>                # Delete memory
qmd memory extract <text>             # Extract from conversation
qmd memory stats                      # Memory stats
qmd memory decay                      # Run decay pass
qmd memory import <file>              # Import memories
qmd memory export [file.json]         # Export memories
```

## MCP Tools

CRUD-aligned naming (`{domain}_{verb}`).

Document search: `doc_search`, `doc_get`, `doc_get_batch`, `doc_status`, `briefing`, `doc_manage`
Memory: `memory_add`, `memory_add_batch`, `memory_search`, `memory_get`, `memory_list`, `memory_update`, `memory_delete`, `memory_extract`, `memory_reflect`, `memory_dream`, `memory_stats`, `memory_register_scopes`
Knowledge: `knowledge_add`, `knowledge_search`, `knowledge_invalidate`, `knowledge_entities`, `knowledge_timeline`, `knowledge_stats`

## Important constraints

- **Never run `qmd collection add`, `qmd embed`, or `qmd update` automatically** — write out commands for the user to run
- **Never modify the SQLite database directly** — use the CLI or SDK
- **Never run `bun build --compile`** — breaks the shell wrapper and sqlite-vec
- **Jiti compatibility** — No top-level await anywhere in the import chain. node-llama-cpp lazy-loaded via dynamic import. db.ts uses synchronous createRequire.
- Node.js ≥22 required (Bun dropped)
- **Build script** syncs `openclaw.plugin.json` version from `package.json`, compiles TS, and injects a shebang into `dist/cli/qmd.js`
- **tsconfig excludes** — `src/bench-*.ts` is excluded from type-checking (standalone benchmark scripts)

## OpenClaw Plugin Install

```sh
openclaw plugins install @tanarchy/qmd@dev
# Then in openclaw.json:
# 1. Add "tanarchy-qmd" to plugins.allow
# 2. Add plugins.entries.tanarchy-qmd with enabled: true + config
# 3. openclaw gateway restart
```

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
