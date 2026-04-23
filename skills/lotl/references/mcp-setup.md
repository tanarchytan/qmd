# QMD Setup Reference

## Install

```bash
npm install -g @tanarchy/lotl@dev
lotl collection add ~/path/to/markdown --name myknowledge
lotl embed
```

## Configure MCP Client

**Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "lotl": { "command": "lotl", "args": ["mcp"] }
  }
}
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "lotl": { "command": "lotl", "args": ["mcp"] }
  }
}
```

**OpenClaw Plugin** (recommended for OpenClaw users — see SKILL.md for full setup):
```bash
openclaw plugins install @tanarchy/lotl@dev
# Then add to plugins.allow + plugins.entries in openclaw.json
```

**OpenClaw MCP** (alternative — MCP sidecar, no plugin hooks):
```json
{
  "mcp": {
    "servers": {
      "lotl": { "command": "lotl", "args": ["mcp"] }
    }
  }
}
```

## HTTP Mode

```bash
lotl mcp --http              # Port 8181
lotl mcp --http --daemon     # Background
lotl mcp stop                # Stop daemon
```

## Tools

### Document Search

#### query

Search with auto-expansion and reranking.

```json
{
  "searches": [
    { "type": "lex", "query": "keyword phrases" },
    { "type": "vec", "query": "natural language question" },
    { "type": "hyde", "query": "hypothetical answer passage..." }
  ],
  "limit": 10,
  "collections": ["optional"],
  "intent": "disambiguation hint"
}
```

| Type | Method | Input |
|------|--------|-------|
| `lex` | BM25 | Keywords (2-5 terms) |
| `vec` | Vector | Question |
| `hyde` | Vector | Answer passage (50-100 words) |

#### get

Retrieve document by path or `#docid`.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path or `#docid` |
| `full` | bool? | Return full content |
| `lineNumbers` | bool? | Add line numbers |

#### multi_get

Retrieve multiple documents.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Glob or comma-separated list |
| `maxBytes` | number? | Skip large files (default 10KB) |

#### status

Index health and collections. No params.

#### briefing

Agent wake-up context: collections, search tips, contexts. No params.

#### manage

Admin operations: `embed`, `update`, `cleanup`, `sync`, `decay`.

### Memory

#### memory_store

Store a memory with auto-dedup and auto-classification.

| Param | Type | Description |
|-------|------|-------------|
| `text` | string | Memory text (required) |
| `category` | string? | preference/decision/fact/entity/reflection |
| `importance` | number? | 0.0-1.0 |
| `scope` | string? | Namespace (default: "global") |

#### memory_recall

Search memories by natural language.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Search query (required) |
| `limit` | number? | Max results (default: 10) |
| `scope` | string? | Namespace |

#### memory_forget

Delete a memory by ID.

#### memory_update

Update text, importance, or category of an existing memory.

#### memory_extract

Extract memories from conversation text (LLM or heuristic).

#### memory_stats

Memory count by tier (peripheral/working/core), category, and scope.

### Knowledge Graph

#### knowledge_store

Store a temporal fact as subject-predicate-object triple. Auto-invalidates conflicting prior facts.

| Param | Type | Description |
|-------|------|-------------|
| `subject` | string | Entity (required) |
| `predicate` | string | Relationship (required) |
| `object` | string | Value (required) |

#### knowledge_query

Query facts, optionally at a point in time.

| Param | Type | Description |
|-------|------|-------------|
| `subject` | string? | Filter by entity |
| `predicate` | string? | Filter by relationship |
| `as_of` | string? | ISO date for point-in-time query |

#### knowledge_invalidate

Mark a fact as no longer valid (sets valid_until to now).

#### knowledge_entities

List all known entities in the knowledge graph.

#### knowledge_timeline

All facts about a specific entity, sorted by time.

#### knowledge_stats

Entity count, fact count, expired count.

## Troubleshooting

- **Not starting**: `which lotl`, `lotl mcp` manually
- **No results**: `lotl collection list`, `lotl embed`
- **Slow first search**: Normal, models loading (~3GB)
- **API errors**: `node setup/scripts/selfcheck.mjs`
