---
name: qmd
description: Search + memory + knowledge graph for AI agents. BM25, vector, RRF fusion, LLM reranking, Weibull decay, temporal knowledge.
license: MIT
compatibility: Node.js >=22. Works standalone (CLI/MCP) or as OpenClaw plugin.
metadata:
  author: tanarchy
  version: "2.1.0-dev"
---

# QMD — Search + Memory + Knowledge Graph

## Status

!`qmd status 2>/dev/null || echo "Not installed: npm install -g @tanarchy/qmd@dev"`

## Install

### Quick Setup (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/tanarchytan/qmd/dev/setup/setup-qmd.sh | bash
```

Detects your environment, picks a provider, writes config, and verifies. Works for both OpenClaw and standalone.

### As OpenClaw Plugin

**Step 1** — Install the plugin:
```bash
openclaw plugins install @tanarchy/qmd@dev
```

**Step 2** — Allow the plugin in `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "allow": ["tanarchy-qmd"]
  }
}
```

**Step 3** — Enable with config:
```json
{
  "plugins": {
    "entries": {
      "tanarchy-qmd": {
        "enabled": true,
        "config": {
          "autoRecall": true,
          "autoCapture": true,
          "embed": {
            "provider": "zeroentropy",
            "apiKey": "${ZEROENTROPY_API_KEY}",
            "model": "zembed-1"
          },
          "rerank": {
            "provider": "zeroentropy",
            "apiKey": "${ZEROENTROPY_API_KEY}",
            "model": "zerank-2"
          }
        }
      }
    }
  }
}
```

**Step 4** — Restart:
```bash
openclaw gateway restart
```

### As MCP Server

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}
```

### As CLI

```bash
npm install -g @tanarchy/qmd@dev
```

## Configuration

### OpenClaw Plugin Config

All provider config lives in `openclaw.json` under `plugins.entries.tanarchy-qmd.config`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoRecall` | boolean | `true` | Inject relevant memories before each turn |
| `autoCapture` | boolean | `true` | Extract memories after each turn |
| `topK` | number | `5` | Max memories to recall |
| `scope` | string | `"global"` | Memory scope (auto-detects agent ID) |
| `local` | boolean | `false` | Enable local GGUF models (requires cmake/GPU) |
| `embed` | object | — | Embedding provider config |
| `rerank` | object | — | Reranking provider config |
| `queryExpansion` | object | — | Query expansion provider config |

Each provider object: `{ "provider", "apiKey", "url", "model", "dimensions" }`

### Provider Examples

**ZeroEntropy (embed + rerank):**
```json
{
  "embed": { "provider": "zeroentropy", "apiKey": "ze-...", "model": "zembed-1" },
  "rerank": { "provider": "zeroentropy", "apiKey": "ze-...", "model": "zerank-2" }
}
```

**SiliconFlow (free tier, all 3 operations):**
```json
{
  "embed": { "provider": "siliconflow", "apiKey": "sk-...", "model": "Qwen/Qwen3-Embedding-8B" },
  "rerank": { "provider": "siliconflow", "apiKey": "sk-...", "model": "BAAI/bge-reranker-v2-m3", "mode": "rerank" },
  "queryExpansion": { "provider": "siliconflow", "apiKey": "sk-...", "model": "zai-org/GLM-4.5-Air" }
}
```

**Nebius embed + ZeroEntropy rerank (best quality):**
```json
{
  "embed": { "provider": "api", "apiKey": "neb-...", "url": "https://api.studio.nebius.ai/v1", "model": "Qwen3-Embedding-8B" },
  "rerank": { "provider": "zeroentropy", "apiKey": "ze-...", "model": "zerank-2" },
  "queryExpansion": { "provider": "api", "apiKey": "neb-...", "url": "https://api.studio.nebius.ai/v1", "model": "meta-llama/Meta-Llama-3.1-70B-Instruct" }
}
```

### Standalone Config (CLI / MCP)

Set env vars in `~/.config/qmd/.env`:
```bash
QMD_LOCAL=no
QMD_EMBED_PROVIDER=zeroentropy
QMD_EMBED_API_KEY=ze-your-key
QMD_EMBED_MODEL=zembed-1
# QMD_EMBED_DIMENSIONS=        # Optional, auto-detected
QMD_RERANK_PROVIDER=zeroentropy
QMD_RERANK_API_KEY=ze-your-key
QMD_RERANK_MODEL=zerank-2
# QMD_RERANK_MODE=rerank       # rerank (dedicated API) or llm (chat model)
# QMD_QUERY_EXPANSION_PROVIDER=siliconflow
# QMD_QUERY_EXPANSION_API_KEY=sk-your-key
# QMD_QUERY_EXPANSION_MODEL=zai-org/GLM-4.5-Air
```

See `.env.example` in the package for all options.

## MCP: `query`

```json
{
  "searches": [
    { "type": "lex", "query": "CAP theorem consistency" },
    { "type": "vec", "query": "tradeoff between consistency and availability" }
  ],
  "collections": ["docs"],
  "limit": 10
}
```

### Query Types

| Type | Method | Input |
|------|--------|-------|
| `lex` | BM25 | Keywords — exact terms, names, code |
| `vec` | Vector | Question — natural language |
| `hyde` | Vector | Answer — hypothetical result (50-100 words) |

### Writing Good Queries

**lex (keyword)**
- 2-5 terms, no filler words
- Exact phrase: `"connection pool"` (quoted)
- Exclude terms: `performance -sports` (minus prefix)
- Code identifiers work: `handleError async`

**vec (semantic)**
- Full natural language question
- Be specific: `"how does the rate limiter handle burst traffic"`
- Include context: `"in the payment service, how are refunds processed"`

**hyde (hypothetical document)**
- Write 50-100 words of what the *answer* looks like
- Use the vocabulary you expect in the result

**expand (auto-expand)**
- Use a single-line query (implicit) or `expand: question` on its own line
- Lets the local LLM generate lex/vec/hyde variations
- Do not mix `expand:` with other typed lines

### Intent (Disambiguation)

When a query term is ambiguous, add `intent` to steer results:

```json
{
  "searches": [
    { "type": "lex", "query": "performance" }
  ],
  "intent": "web page load times and Core Web Vitals"
}
```

### Combining Types

| Goal | Approach |
|------|----------|
| Know exact terms | `lex` only |
| Don't know vocabulary | Use a single-line query (implicit `expand:`) or `vec` |
| Best recall | `lex` + `vec` |
| Complex topic | `lex` + `vec` + `hyde` |
| Ambiguous query | Add `intent` to any combination above |

First query gets 2x weight in fusion — put your best guess first.

## Other MCP Tools

### Document Tools

| Tool | Use |
|------|-----|
| `get` | Retrieve doc by path or `#docid` |
| `multi_get` | Retrieve multiple by glob/list |
| `status` | Collections and health |
| `briefing` | Agent wake-up: collections, contexts, search tips |
| `manage` | Admin: `embed`, `update`, `cleanup`, `sync`, `decay` |

### Memory Tools

| Tool | Use |
|------|-----|
| `memory_store` | Store a memory (auto-dedup, auto-classify) |
| `memory_recall` | Search memories (hybrid: FTS + vector + decay) |
| `memory_forget` | Delete a memory |
| `memory_update` | Update text/importance/category |
| `memory_extract` | Extract memories from conversation text |
| `memory_stats` | Memory count by tier/category/scope |

### Knowledge Graph Tools

| Tool | Use |
|------|-----|
| `knowledge_store` | Store a temporal fact (auto-invalidates conflicts) |
| `knowledge_query` | Query facts (optionally at a point in time) |
| `knowledge_invalidate` | Mark a fact as no longer valid |
| `knowledge_entities` | List all known entities |
| `knowledge_timeline` | All facts about entity, sorted by time |
| `knowledge_stats` | Entity count, fact count, expired count |

## CLI

```bash
qmd query "question"              # Auto-expand + rerank
qmd query $'lex: X\nvec: Y'       # Structured
qmd query --json --explain "q"    # Show score traces
qmd search "keywords"             # BM25 only (no LLM)
qmd get "#abc123"                 # By docid
qmd multi-get "journals/2026-*.md" -l 40  # Batch by glob
qmd memory store "I prefer TypeScript"    # Store (auto-classify)
qmd memory recall "what language"         # Search memories
qmd memory extract "conversation text"    # Extract from conversation
qmd memory stats                          # Stats by tier/category
qmd memory decay                          # Run decay pass
qmd memory import conversations.json      # Import conversations
qmd memory export memories.json           # Export all memories
```

## Setup

```bash
qmd collection add ~/notes --name notes
qmd embed
```

## Verification

```bash
qmd status                                # Check index health
qmd memory store "test" && qmd memory recall "test"  # Test memory
openclaw plugins doctor                   # Check plugin (OpenClaw)
node setup/scripts/selfcheck.mjs          # Probe endpoints
node setup/scripts/config-validate.mjs    # Validate config
```

## Troubleshooting

- **Plugin not loading**: `openclaw plugins doctor`, then `rm -rf /tmp/jiti/` and restart gateway
- **No embeddings**: `qmd embed -f` to force re-embed
- **Dimension mismatch** after provider change: `qmd embed -f`
- **API key issues**: `node setup/scripts/selfcheck.mjs` to probe endpoints
- **Config issues**: `node setup/scripts/config-validate.mjs`
- **Not starting**: check `which qmd`, try `qmd mcp` manually
