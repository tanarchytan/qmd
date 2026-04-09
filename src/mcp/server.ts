/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Follows MCP spec 2025-06-18 for proper response types.
 */

import { loadQmdEnv } from "../env.js";
loadQmdEnv();

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync } from "fs";
import {
  createStore,
  extractSnippet,
  addLineNumbers,
  getDefaultDbPath,
  DEFAULT_MULTI_GET_MAX_BYTES,
  type QMDStore,
  type ExpandedQuery,
  type IndexStatus,
} from "../index.js";
import { getConfigPath } from "../collections.js";
import { deleteLLMCache, cleanupOrphanedVectors, vacuumDatabase, listCollections as storeListCollections, generateEmbeddings, reindexCollection } from "../store.js";
import { memoryStore, memoryRecall, memoryForget, memoryUpdate, memoryStats, runDecayPass, extractAndStore, knowledgeStore, knowledgeQuery, knowledgeInvalidate, knowledgeEntities, knowledgeTimeline, knowledgeStats, MEMORY_CATEGORIES } from "../memory/index.js";

// =============================================================================
// Types for structured content
// =============================================================================

type SearchResultItem = {
  docid: string;  // Short docid (#abc123) for quick reference
  file: string;
  title: string;
  score: number;
  context: string | null;
  snippet: string;
};

type StatusResult = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: {
    name: string;
    path: string | null;
    pattern: string | null;
    documents: number;
    lastUpdated: string;
  }[];
};

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Encode a path for use in qmd:// URIs.
 * Encodes special characters but preserves forward slashes for readability.
 */
function encodeQmdPath(path: string): string {
  // Encode each path segment separately to preserve slashes
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Format search results as human-readable text summary
 */
function formatSearchSummary(results: SearchResultItem[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }
  const lines = [`Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n`];
  for (const r of results) {
    lines.push(`${r.docid} ${Math.round(r.score * 100)}% ${r.file} - ${r.title}`);
  }
  return lines.join('\n');
}

function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// =============================================================================
// MCP Server
// =============================================================================

/**
 * Build dynamic server instructions from actual index state.
 * Injected into the LLM's system prompt via MCP initialize response —
 * gives the LLM immediate context about what's searchable without a tool call.
 */
// Cached instructions — rebuilt every 60 seconds or on first call
let _instructionsCache: { text: string; builtAt: number } | null = null;
const INSTRUCTIONS_TTL_MS = 60_000;

async function buildInstructions(store: QMDStore): Promise<string> {
  if (_instructionsCache && Date.now() - _instructionsCache.builtAt < INSTRUCTIONS_TTL_MS) {
    return _instructionsCache.text;
  }
  const status = await store.getStatus();
  const contexts = await store.listContexts();
  const globalCtx = await store.getGlobalContext();
  const lines: string[] = [];

  // --- What is this? ---
  lines.push(`QMD is your local search engine over ${status.totalDocuments} markdown documents.`);
  if (globalCtx) lines.push(`Context: ${globalCtx}`);

  // --- What's searchable? ---
  if (status.collections.length > 0) {
    lines.push("");
    lines.push("Collections (scope with `collections` parameter for better accuracy):");
    for (const col of status.collections) {
      const rootCtx = contexts.find(c => c.collection === col.name && (c.path === "" || c.path === "/"));
      const desc = rootCtx ? ` — ${rootCtx.context}` : "";
      lines.push(`  - "${col.name}" (${col.documents} docs)${desc}`);
      // Show sub-path contexts for hierarchical filtering
      const subCtxs = contexts.filter(c => c.collection === col.name && c.path !== "" && c.path !== "/");
      for (const sub of subCtxs) {
        lines.push(`      ${sub.path}: ${sub.context}`);
      }
    }
    lines.push("");
    lines.push("IMPORTANT: Always scope searches to relevant collections when possible.");
    lines.push("Searching within specific collections is significantly more accurate than searching everything.");
    lines.push("Example: searches=[{type:'lex', query:'deployment'}], collections=['arachnid-vault']");
  }

  // --- Capability gaps ---
  if (!status.hasVectorIndex) {
    lines.push("");
    lines.push("Note: No vector embeddings yet. Run `qmd embed` to enable semantic search (vec/hyde).");
  } else if (status.needsEmbedding > 0) {
    lines.push("");
    lines.push(`Note: ${status.needsEmbedding} documents need embedding. Run \`qmd embed\` to update.`);
  }

  // --- Search tool ---
  lines.push("");
  lines.push("Search: Use `query` with sub-queries (lex/vec/hyde):");
  lines.push("  - type:'lex' — BM25 keyword search (exact terms, fast)");
  lines.push("  - type:'vec' — semantic vector search (meaning-based)");
  lines.push("  - type:'hyde' — hypothetical document (write what the answer looks like)");
  lines.push("");
  lines.push("  Always provide `intent` on every search call to disambiguate and improve snippets.");
  lines.push("");
  lines.push("Examples:");
  lines.push("  Quick keyword lookup: [{type:'lex', query:'error handling'}]");
  lines.push("  Semantic search: [{type:'vec', query:'how to handle errors gracefully'}]");
  lines.push("  Best results: [{type:'lex', query:'error'}, {type:'vec', query:'error handling best practices'}]");
  lines.push("  With intent: searches=[{type:'lex', query:'performance'}], intent='web page load times'");

  // --- Retrieval workflow ---
  lines.push("");
  lines.push("Retrieval:");
  lines.push("  - `get` — single document by path or docid (#abc123). Supports line offset (`file.md:100`).");
  lines.push("  - `multi_get` — batch retrieve by glob (`journals/2025-05*.md`) or comma-separated list.");

  // --- Non-obvious things that prevent mistakes ---
  lines.push("");
  lines.push("Tips:");
  lines.push("  - File paths in results are relative to their collection.");
  lines.push("  - Use `minScore: 0.5` to filter low-confidence results.");
  lines.push("  - Results include a `context` field describing the content type.");

  const result = lines.join("\n");
  _instructionsCache = { text: result, builtAt: Date.now() };
  return result;
}

/**
 * Create an MCP server with all QMD tools, resources, and prompts registered.
 * Shared by both stdio and HTTP transports.
 */
async function createMcpServer(store: QMDStore): Promise<McpServer> {
  const server = new McpServer(
    { name: "qmd", version: getPackageVersion() },
    { instructions: await buildInstructions(store) },
  );

  // Pre-fetch default collection names for search tools
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // ---------------------------------------------------------------------------
  // Resource: qmd://{path} - read-only access to documents by path
  // Note: No list() - documents are discovered via search tools
  // ---------------------------------------------------------------------------

  server.registerResource(
    "document",
    new ResourceTemplate("qmd://{+path}", { list: undefined }),
    {
      title: "QMD Document",
      description: "A markdown document from your QMD knowledge base. Use search tools to discover documents.",
      mimeType: "text/markdown",
    },
    async (uri, { path }) => {
      // Decode URL-encoded path (MCP clients send encoded URIs)
      const pathStr = Array.isArray(path) ? path.join('/') : (path || '');
      const decodedPath = decodeURIComponent(pathStr);

      // Use SDK to find document — findDocument handles collection/path resolution
      const result = await store.get(decodedPath, { includeBody: true });

      if ("error" in result) {
        return { contents: [{ uri: uri.href, text: `Document not found: ${decodedPath}` }] };
      }

      let text = addLineNumbers(result.body || "");  // Default to line numbers
      if (result.context) {
        text = `<!-- Context: ${result.context} -->\n\n` + text;
      }

      return {
        contents: [{
          uri: uri.href,
          name: result.displayPath,
          title: result.title || result.displayPath,
          mimeType: "text/markdown",
          text,
        }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: query (Primary search tool)
  // ---------------------------------------------------------------------------

  const subSearchSchema = z.object({
    type: z.enum(['lex', 'vec', 'hyde']).describe(
      "lex = BM25 keywords (supports \"phrase\" and -negation); " +
      "vec = semantic question; hyde = hypothetical answer passage"
    ),
    query: z.string().describe(
      "The query text. For lex: use keywords, \"quoted phrases\", and -negation. " +
      "For vec: natural language question. For hyde: 50-100 word answer passage."
    ),
  });

  server.registerTool(
    "query",
    {
      title: "Query",
      description: `Search the knowledge base using a query document — one or more typed sub-queries combined for best recall.

## Query Types

**lex** — BM25 keyword search. Fast, exact, no LLM needed.
Full lex syntax:
- \`term\` — prefix match ("perf" matches "performance")
- \`"exact phrase"\` — phrase must appear verbatim
- \`-term\` or \`-"phrase"\` — exclude documents containing this

Good lex examples:
- \`"connection pool" timeout -redis\`
- \`"machine learning" -sports -athlete\`
- \`handleError async typescript\`

**vec** — Semantic vector search. Write a natural language question. Finds documents by meaning, not exact words.
- \`how does the rate limiter handle burst traffic?\`
- \`what is the tradeoff between consistency and availability?\`

**hyde** — Hypothetical document. Write 50-100 words that look like the answer. Often the most powerful for nuanced topics.
- \`The rate limiter uses a token bucket algorithm. When a client exceeds 100 req/min, subsequent requests return 429 until the window resets.\`

## Strategy

Combine types for best results. First sub-query gets 2× weight — put your strongest signal first.

| Goal | Approach |
|------|----------|
| Know exact term/name | \`lex\` only |
| Concept search | \`vec\` only |
| Best recall | \`lex\` + \`vec\` |
| Complex/nuanced | \`lex\` + \`vec\` + \`hyde\` |
| Unknown vocabulary | Use a standalone natural-language query (no typed lines) so the server can auto-expand it |

## Examples

Simple lookup:
\`\`\`json
[{ "type": "lex", "query": "CAP theorem" }]
\`\`\`

Best recall on a technical topic:
\`\`\`json
[
  { "type": "lex", "query": "\\"connection pool\\" timeout -redis" },
  { "type": "vec", "query": "why do database connections time out under load" },
  { "type": "hyde", "query": "Connection pool exhaustion occurs when all connections are in use and new requests must wait. This typically happens under high concurrency when queries run longer than expected." }
]
\`\`\`

Intent-aware lex (C++ performance, not sports):
\`\`\`json
[
  { "type": "lex", "query": "\\"C++ performance\\" optimization -sports -athlete" },
  { "type": "vec", "query": "how to optimize C++ program performance" }
]
\`\`\``,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        searches: z.array(subSearchSchema).min(1).max(10).describe(
          "Typed sub-queries to execute (lex/vec/hyde). First gets 2x weight."
        ),
        limit: z.number().optional().default(10).describe("Max results (default: 10)"),
        minScore: z.number().optional().default(0).describe("Min relevance 0-1 (default: 0)"),
        candidateLimit: z.number().optional().describe(
          "Maximum candidates to rerank (default: 40, lower = faster but may miss results)"
        ),
        collections: z.array(z.string()).optional().describe("Filter to collections (OR match)"),
        intent: z.string().optional().describe(
          "Background context to disambiguate the query. Example: query='performance', intent='web page load times and Core Web Vitals'. Does not search on its own."
        ),
        rerank: z.boolean().optional().default(true).describe(
          "Rerank results using LLM (default: true). Set to false for faster results on CPU-only machines."
        ),
      },
    },
    async ({ searches, limit, minScore, candidateLimit, collections, intent, rerank }) => {
      // Map to internal format
      const queries: ExpandedQuery[] = searches.map(s => ({
        type: s.type,
        query: s.query,
      }));

      // Use default collections if none specified
      const effectiveCollections = collections ?? defaultCollectionNames;

      const results = await store.search({
        queries,
        collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
        limit,
        minScore,
        rerank,
        intent,
      });

      // Use first lex or vec query for snippet extraction
      const primaryQuery = searches.find(s => s.type === 'lex')?.query
        || searches.find(s => s.type === 'vec')?.query
        || searches[0]?.query || "";

      const filtered: SearchResultItem[] = results.map(r => {
        const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300, undefined, undefined, intent);
        return {
          docid: `#${r.docid}`,
          file: r.displayPath,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: r.context,
          snippet: addLineNumbers(snippet, line),
        };
      });

      return {
        content: [{ type: "text", text: formatSearchSummary(filtered, primaryQuery) }],
        structuredContent: { results: filtered },
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_get (Retrieve document)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get",
    {
      title: "Get Document",
      description: "Retrieve the full content of a document by its file path or docid. Use paths or docids (#abc123) from search results. Suggests similar files if not found.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        file: z.string().describe("File path or docid from search results (e.g., 'pages/meeting.md', '#abc123', or 'pages/meeting.md:100' to start at line 100)"),
        fromLine: z.number().optional().describe("Start from this line number (1-indexed)"),
        maxLines: z.number().optional().describe("Maximum number of lines to return"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ file, fromLine, maxLines, lineNumbers }) => {
      // Support :line suffix in `file` (e.g. "foo.md:120") when fromLine isn't provided
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      const result = await store.get(lookup, { includeBody: false });

      if ("error" in result) {
        let msg = `Document not found: ${file}`;
        if (result.similarFiles.length > 0) {
          msg += `\n\nDid you mean one of these?\n${result.similarFiles.map(s => `  - ${s}`).join('\n')}`;
        }
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      const body = await store.getDocumentBody(result.filepath, { fromLine: parsedFromLine, maxLines }) ?? "";
      let text = body;
      if (lineNumbers) {
        const startLine = parsedFromLine || 1;
        text = addLineNumbers(text, startLine);
      }
      if (result.context) {
        text = `<!-- Context: ${result.context} -->\n\n` + text;
      }

      return {
        content: [{
          type: "resource",
          resource: {
            uri: `qmd://${encodeQmdPath(result.displayPath)}`,
            name: result.displayPath,
            title: result.title,
            mimeType: "text/markdown",
            text,
          },
        }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_multi_get (Retrieve multiple documents)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description: "Retrieve multiple documents by glob pattern (e.g., 'journals/2025-05*.md') or comma-separated list. Skips files larger than maxBytes.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        pattern: z.string().describe("Glob pattern or comma-separated list of file paths"),
        maxLines: z.number().optional().describe("Maximum lines per file"),
        maxBytes: z.number().optional().default(10240).describe("Skip files larger than this (default: 10240 = 10KB)"),
        lineNumbers: z.boolean().optional().default(false).describe("Add line numbers to output (format: 'N: content')"),
      },
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers }) => {
      const { docs, errors } = await store.multiGet(pattern, { includeBody: true, maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES });

      if (docs.length === 0 && errors.length === 0) {
        return {
          content: [{ type: "text", text: `No files matched pattern: ${pattern}` }],
          isError: true,
        };
      }

      const content: ({ type: "text"; text: string } | { type: "resource"; resource: { uri: string; name: string; title?: string; mimeType: string; text: string } })[] = [];

      if (errors.length > 0) {
        content.push({ type: "text", text: `Errors:\n${errors.join('\n')}` });
      }

      for (const result of docs) {
        if (result.skipped) {
          content.push({
            type: "text",
            text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use 'qmd_get' with file="${result.doc.displayPath}" to retrieve.]`,
          });
          continue;
        }

        let text = result.doc.body || "";
        if (maxLines !== undefined) {
          const lines = text.split("\n");
          text = lines.slice(0, maxLines).join("\n");
          if (lines.length > maxLines) {
            text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
          }
        }
        if (lineNumbers) {
          text = addLineNumbers(text);
        }
        if (result.doc.context) {
          text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
        }

        content.push({
          type: "resource",
          resource: {
            uri: `qmd://${encodeQmdPath(result.doc.displayPath)}`,
            name: result.doc.displayPath,
            title: result.doc.title,
            mimeType: "text/markdown",
            text,
          },
        });
      }

      return { content };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: qmd_status (Index status)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Index Status",
      description: "Show the status of the QMD index: collections, document counts, and health information.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const status: StatusResult = await store.getStatus();

      const summary = [
        `QMD Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? 'yes' : 'no'}`,
        `  Collections: ${status.collections.length}`,
      ];

      for (const col of status.collections) {
        summary.push(`    - ${col.name}: ${col.path} (${col.documents} docs)`);
      }

      return {
        content: [{ type: "text", text: summary.join('\n') }],
        structuredContent: status,
      };
    }
  );

  // =========================================================================
  // Tool: briefing — wake-up context for agents
  // =========================================================================
  server.registerTool(
    "briefing",
    {
      title: "Collection Briefing",
      description: [
        "Get a detailed briefing of all collections, their contexts, and structure.",
        "Call this when you need to understand what's available before searching.",
        "Returns collection map with document counts, contexts, and search tips.",
      ].join("\n"),
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const status: StatusResult = await store.getStatus();
      const contexts = await store.listContexts();
      const globalCtx = await store.getGlobalContext();
      const lines: string[] = [];

      lines.push(`# QMD Briefing — ${status.totalDocuments} documents indexed`);
      if (globalCtx) lines.push(`\nGlobal context: ${globalCtx}`);
      lines.push(`\nVector index: ${status.hasVectorIndex ? 'active' : 'not built'}${status.needsEmbedding > 0 ? ` (${status.needsEmbedding} pending — run manage({ operation: "embed" }))` : ''}`);

      lines.push(`\n## Collections\n`);
      for (const col of status.collections) {
        const rootCtx = contexts.find(c => c.collection === col.name && (c.path === "" || c.path === "/"));
        lines.push(`### ${col.name} (${col.documents} docs)`);
        if (rootCtx) lines.push(`${rootCtx.context}`);
        lines.push(`Search: collections=["${col.name}"]`);

        const subCtxs = contexts.filter(c => c.collection === col.name && c.path !== "" && c.path !== "/");
        if (subCtxs.length > 0) {
          lines.push(`\nTopics:`);
          for (const sub of subCtxs) {
            lines.push(`  - ${sub.path}: ${sub.context}`);
          }
        }
        lines.push('');
      }

      lines.push(`## Search Strategy\n`);
      lines.push(`1. **Always scope to collections** — searching within specific collections is ~35% more accurate than searching everything.`);
      lines.push(`2. **Use intent** — add intent parameter to disambiguate queries (e.g., intent="web performance" for query "performance").`);
      lines.push(`3. **Combine query types** — lex for exact terms, vec for meaning, hyde for hypothetical answers.`);
      lines.push(`4. **Use contexts as routing hints** — match your query topic to collection contexts above to pick the right collection.`);

      return {
        content: [{ type: "text", text: lines.join('\n') }],
      };
    }
  );

  // =========================================================================
  // Memory tools — conversation memory for agents
  // =========================================================================

  server.registerTool(
    "memory_store",
    {
      title: "Store Memory",
      description: "Store a fact, preference, decision, or other memory. Deduplicates automatically (exact match + semantic similarity). Returns the memory ID.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        text: z.string().describe("The memory content to store (verbatim text)"),
        category: z.enum(["preference", "fact", "decision", "entity", "reflection", "other"]).optional().describe("Memory category (default: other)"),
        scope: z.string().optional().describe("Scope for isolation: agent name, project, or 'global' (default: global)"),
        importance: z.number().min(0).max(1).optional().describe("Importance 0-1 (default: 0.5). Higher = persists longer."),
      },
    },
    async ({ text, category, scope, importance }) => {
      const db = store.internal.db;
      const result = await memoryStore(db, { text, category, scope, importance });
      const msg = result.status === "created"
        ? `Memory stored (id: ${result.id})`
        : `Duplicate found (existing id: ${result.duplicate_id})`;
      return { content: [{ type: "text", text: msg }] };
    }
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall Memories",
      description: "Search memories by natural language query. Uses hybrid search (semantic + keyword). Returns ranked results.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z.string().describe("Search query"),
        scope: z.string().optional().describe("Filter by scope (agent name, project, or 'global')"),
        category: z.enum(["preference", "fact", "decision", "entity", "reflection", "other"]).optional().describe("Filter by category"),
        limit: z.number().optional().describe("Max results (default: 10)"),
      },
    },
    async ({ query, scope, category, limit }) => {
      const db = store.internal.db;
      const results = await memoryRecall(db, { query, scope, category, limit });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No memories found." }] };
      }
      const lines = results.map((r, i) =>
        `${i + 1}. [${r.category}] (score: ${r.score.toFixed(2)}, scope: ${r.scope}) ${r.text}\n   id: ${r.id}`
      );
      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: { results },
      };
    }
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget Memory",
      description: "Delete a specific memory by ID.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Memory ID to delete"),
      },
    },
    async ({ id }) => {
      const db = store.internal.db;
      const result = memoryForget(db, id);
      return {
        content: [{ type: "text", text: result.deleted ? `Memory ${id} deleted.` : `Memory ${id} not found.` }],
      };
    }
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update Memory",
      description: "Update an existing memory's text, importance, or category. Re-embeds if text changes.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Memory ID to update"),
        text: z.string().optional().describe("New memory text (triggers re-embedding)"),
        importance: z.number().min(0).max(1).optional().describe("New importance 0-1"),
        category: z.enum(["preference", "fact", "decision", "entity", "reflection", "other"]).optional().describe("New category"),
      },
    },
    async ({ id, text, importance, category }) => {
      const db = store.internal.db;
      const result = await memoryUpdate(db, { id, text, importance, category });
      return {
        content: [{ type: "text", text: result.updated ? `Memory ${id} updated.` : `Memory ${id} not found.` }],
      };
    }
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory Statistics",
      description: "Show memory statistics: total count, breakdown by tier, category, and scope.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const db = store.internal.db;
      const stats = memoryStats(db);
      const lines = [
        `Total memories: ${stats.total}`,
        `\nBy tier: ${Object.entries(stats.byTier).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`,
        `By category: ${Object.entries(stats.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`,
        `By scope: ${Object.entries(stats.byScope).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`,
      ];
      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: stats,
      };
    }
  );

  server.registerTool(
    "memory_extract",
    {
      title: "Extract Memories",
      description: [
        "Extract and store memories from conversation text.",
        "Uses LLM if configured (query expansion provider), otherwise uses heuristic pattern matching.",
        "Automatically classifies into: preference, fact, decision, entity, reflection.",
        "Also extracts preference patterns for enhanced recall.",
        "Deduplicates against existing memories.",
      ].join("\n"),
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        text: z.string().describe("Conversation text to extract memories from"),
        scope: z.string().optional().describe("Scope for extracted memories (default: global)"),
      },
    },
    async ({ text, scope }) => {
      const db = store.internal.db;
      const result = await extractAndStore(db, text, scope);
      const lines = [
        `Extracted ${result.extracted.length} memories: ${result.stored} stored, ${result.duplicates} duplicates`,
      ];
      if (result.extracted.length > 0) {
        for (const mem of result.extracted.slice(0, 10)) {
          lines.push(`  [${mem.category}] ${mem.text.slice(0, 100)}${mem.text.length > 100 ? '...' : ''}`);
        }
      }
      if (result.preferences.length > 0) {
        lines.push(`\nPreference patterns: ${result.preferences.length}`);
        for (const p of result.preferences.slice(0, 5)) {
          lines.push(`  ${p}`);
        }
      }
      return { content: [{ type: "text", text: lines.join('\n') }] };
    }
  );

  // =========================================================================
  // Knowledge graph tools — temporal entity-relationship triples
  // =========================================================================

  server.registerTool(
    "knowledge_store",
    {
      title: "Store Knowledge",
      description: [
        "Store a fact as a subject-predicate-object triple with optional time validity.",
        "Auto-invalidates conflicting prior facts on the same subject+predicate.",
        "Entity names are normalized to slugs (e.g. 'David Gillot' → 'david_gillot').",
      ].join("\n"),
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        subject: z.string().describe("Entity name (e.g. 'David', 'QMD project')"),
        predicate: z.string().describe("Relationship (e.g. 'prefers', 'works_at', 'uses')"),
        object: z.string().describe("Value (e.g. 'ZeroEntropy', 'Tanarchy', 'TypeScript')"),
        valid_from: z.number().optional().describe("Timestamp (ms) when this became true (default: now)"),
        confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1 (default: 1.0)"),
      },
    },
    async ({ subject, predicate, object, valid_from, confidence }) => {
      const db = store.internal.db;
      const result = knowledgeStore(db, { subject, predicate, object, valid_from, confidence });
      const msg = result.invalidated.length > 0
        ? `Fact stored (id: ${result.id}). Invalidated ${result.invalidated.length} prior fact(s).`
        : `Fact stored (id: ${result.id}).`;
      return { content: [{ type: "text", text: msg }] };
    }
  );

  server.registerTool(
    "knowledge_query",
    {
      title: "Query Knowledge",
      description: [
        "Query the knowledge graph for facts about entities.",
        "Filter by subject, predicate, object, or point-in-time.",
        "as_of: return only facts valid at that timestamp.",
      ].join("\n"),
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        subject: z.string().optional().describe("Entity to query (e.g. 'David')"),
        predicate: z.string().optional().describe("Relationship filter (e.g. 'prefers')"),
        object: z.string().optional().describe("Value filter (partial match)"),
        as_of: z.number().optional().describe("Timestamp (ms) — show facts valid at this time"),
        limit: z.number().optional().describe("Max results (default: 50)"),
      },
    },
    async ({ subject, predicate, object, as_of, limit }) => {
      const db = store.internal.db;
      const results = knowledgeQuery(db, { subject, predicate, object, as_of, limit });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No facts found." }] };
      }
      const lines = results.map(r => {
        const validity = r.valid_until ? ` [expired ${new Date(r.valid_until).toISOString().slice(0, 10)}]` : "";
        return `${r.subject} → ${r.predicate} → ${r.object}${validity} (confidence: ${r.confidence})`;
      });
      return {
        content: [{ type: "text", text: lines.join('\n') }],
        structuredContent: { results },
      };
    }
  );

  server.registerTool(
    "knowledge_invalidate",
    {
      title: "Invalidate Knowledge",
      description: "Mark a fact as no longer valid (sets valid_until to now). The fact remains in history.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        id: z.string().describe("Fact ID to invalidate"),
      },
    },
    async ({ id }) => {
      const db = store.internal.db;
      const result = knowledgeInvalidate(db, id);
      return {
        content: [{ type: "text", text: result.invalidated ? `Fact ${id} invalidated.` : `Fact ${id} not found or already invalidated.` }],
      };
    }
  );

  server.registerTool(
    "knowledge_entities",
    {
      title: "List Entities",
      description: "List all known entities in the knowledge graph.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const db = store.internal.db;
      const entities = knowledgeEntities(db);
      if (entities.length === 0) {
        return { content: [{ type: "text", text: "No entities in knowledge graph." }] };
      }
      return { content: [{ type: "text", text: `Entities (${entities.length}):\n${entities.join('\n')}` }] };
    }
  );

  server.registerTool(
    "knowledge_timeline",
    {
      title: "Knowledge Timeline",
      description: "Show all facts about an entity over time (including expired).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        subject: z.string().describe("Entity name"),
      },
    },
    async ({ subject }) => {
      const db = store.internal.db;
      const facts = knowledgeTimeline(db, subject);
      if (facts.length === 0) return { content: [{ type: "text", text: `No facts found for "${subject}".` }] };
      const lines = facts.map(r => {
        const from = r.valid_from ? new Date(r.valid_from).toISOString().slice(0, 10) : "always";
        const until = r.valid_until ? new Date(r.valid_until).toISOString().slice(0, 10) : "current";
        return `${from} → ${until}: ${r.subject} → ${r.predicate} → ${r.object}`;
      });
      return { content: [{ type: "text", text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    "knowledge_stats",
    {
      title: "Knowledge Stats",
      description: "Show knowledge graph statistics: entity count, fact count, active vs expired.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const db = store.internal.db;
      const stats = knowledgeStats(db);
      return {
        content: [{ type: "text", text: `Entities: ${stats.entities}\nFacts: ${stats.facts} (${stats.activeFacts} active, ${stats.expiredFacts} expired)` }],
        structuredContent: stats,
      };
    }
  );

  // =========================================================================
  // Tool: manage — administrative operations (embed, update, cleanup, sync)
  // =========================================================================
  server.registerTool(
    "manage",
    {
      title: "Manage QMD Index",
      description: [
        "Administrative operations for QMD index maintenance.",
        "",
        "Operations:",
        "- **embed**: Generate vector embeddings for pending documents (uses remote provider if configured)",
        "- **update**: Re-index collections to pick up file changes (optionally specify a collection name)",
        "- **cleanup**: Clear LLM cache, remove orphaned vectors, and vacuum the database",
        "- **sync**: Update all collections + embed pending documents in one step",
      ].join("\n"),
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        operation: z.enum(["embed", "update", "cleanup", "sync", "decay"]).describe("Operation to run"),
        collection: z.string().optional().describe("Collection name (for update). Omit to update all."),
        force: z.boolean().optional().describe("Force re-embed all documents (for embed/sync)"),
      },
    },
    async ({ operation, collection, force }) => {
      const internal = store.internal;
      const db = internal.db;

      if (operation === "embed" || operation === "sync") {
        if (operation === "sync") {
          // Re-index all collections first
          const collections = storeListCollections(db);
          for (const col of collections) {
            await reindexCollection(internal, col.pwd, col.glob_pattern || "**/*.md", col.name);
          }
        }
        const result = await generateEmbeddings(internal, { force: !!force });
        return {
          content: [{
            type: "text",
            text: `Embedding complete: ${result.chunksEmbedded} chunks embedded, ${result.errors} errors, ${result.docsProcessed} docs processed (${result.durationMs}ms)`,
          }],
        };
      }

      if (operation === "update") {
        const collections = storeListCollections(db);
        const targets = collection
          ? collections.filter(c => c.name === collection)
          : collections;
        if (targets.length === 0) {
          return { content: [{ type: "text", text: collection ? `Collection "${collection}" not found.` : "No collections configured." }] };
        }
        const results: string[] = [];
        for (const col of targets) {
          const r = await reindexCollection(internal, col.pwd, col.glob_pattern || "**/*.md", col.name);
          results.push(`${col.name}: ${r.indexed} indexed, ${r.updated} updated, ${r.removed} removed`);
        }
        return { content: [{ type: "text", text: `Update complete:\n${results.join('\n')}` }] };
      }

      if (operation === "cleanup") {
        const cacheCount = deleteLLMCache(db);
        const orphanCount = cleanupOrphanedVectors(db);
        vacuumDatabase(db);
        return {
          content: [{
            type: "text",
            text: `Cleanup complete: ${cacheCount} cache entries cleared, ${orphanCount} orphaned vectors removed, database vacuumed.`,
          }],
        };
      }

      if (operation === "decay") {
        const result = runDecayPass(db);
        const lines = [
          `Decay pass: ${result.processed} memories, ${result.promoted} promoted, ${result.demoted} demoted, ${result.stale} stale`,
        ];
        for (const c of result.changes.slice(0, 10)) {
          lines.push(`  ${c.id.slice(0, 8)}: ${c.oldTier} → ${c.newTier} (score: ${c.composite.toFixed(3)})`);
        }
        if (result.changes.length > 10) lines.push(`  ... and ${result.changes.length - 10} more`);
        return { content: [{ type: "text", text: lines.join('\n') }] };
      }

      return { content: [{ type: "text", text: `Unknown operation: ${operation}` }] };
    }
  );

  return server;
}

// =============================================================================
// Transport: stdio (default)
// =============================================================================

export async function startMcpServer(): Promise<void> {
  const configPath = getConfigPath();
  const store = await createStore({
    dbPath: getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });
  const server = await createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// =============================================================================
// Transport: Streamable HTTP
// =============================================================================

export type HttpServerHandle = {
  httpServer: import("http").Server;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Start MCP server over Streamable HTTP (JSON responses, no SSE).
 * Binds to localhost only. Returns a handle for shutdown and port discovery.
 */
export async function startMcpHttpServer(port: number, options?: { quiet?: boolean }): Promise<HttpServerHandle> {
  const configPath = getConfigPath();
  const store = await createStore({
    dbPath: getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });

  // Pre-fetch default collection names for REST endpoint
  const defaultCollectionNames = await store.getDefaultCollectionNames();

  // Session map: each client gets its own McpServer + Transport pair (MCP spec requirement).
  // The store is shared — it's stateless SQLite, safe for concurrent access.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  async function createSession(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
        log(`${ts()} New session ${sessionId} (${sessions.size} active)`);
      },
    });
    const server = await createMcpServer(store);
    await server.connect(transport);

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    return transport;
  }

  const startTime = Date.now();
  const quiet = options?.quiet ?? false;

  /** Format timestamp for request logging */
  function ts(): string {
    return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  }

  /** Extract a human-readable label from a JSON-RPC body */
  function describeRequest(body: any): string {
    const method = body?.method ?? "unknown";
    if (method === "tools/call") {
      const tool = body.params?.name ?? "?";
      const args = body.params?.arguments;
      // Show query string if present, truncated
      if (args?.query) {
        const q = String(args.query).slice(0, 80);
        return `tools/call ${tool} "${q}"`;
      }
      if (args?.path) return `tools/call ${tool} ${args.path}`;
      if (args?.pattern) return `tools/call ${tool} ${args.pattern}`;
      return `tools/call ${tool}`;
    }
    return method;
  }

  function log(msg: string): void {
    if (!quiet) console.error(msg);
  }

  // Helper to collect request body
  async function collectBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  }

  const httpServer = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    const reqStart = Date.now();
    const pathname = nodeReq.url || "/";

    try {
      if (pathname === "/health" && nodeReq.method === "GET") {
        const body = JSON.stringify({ status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) });
        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(body);
        log(`${ts()} GET /health (${Date.now() - reqStart}ms)`);
        return;
      }

      // REST endpoint: POST /search — structured search without MCP protocol
      // REST endpoint: POST /query (alias: /search) — structured search without MCP protocol
      if ((pathname === "/query" || pathname === "/search") && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const params = JSON.parse(rawBody);

        // Validate required fields
        if (!params.searches || !Array.isArray(params.searches)) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({ error: "Missing required field: searches (array)" }));
          return;
        }

        // Map to internal format
        const queries: ExpandedQuery[] = params.searches.map((s: any) => ({
          type: s.type as 'lex' | 'vec' | 'hyde',
          query: String(s.query || ""),
        }));

        // Use default collections if none specified
        const effectiveCollections = params.collections ?? defaultCollectionNames;

        const results = await store.search({
          queries,
          collections: effectiveCollections.length > 0 ? effectiveCollections : undefined,
          limit: params.limit ?? 10,
          minScore: params.minScore ?? 0,
          intent: params.intent,
        });

        // Use first lex or vec query for snippet extraction
        const primaryQuery = params.searches.find((s: any) => s.type === 'lex')?.query
          || params.searches.find((s: any) => s.type === 'vec')?.query
          || params.searches[0]?.query || "";

        const formatted = results.map(r => {
          const { line, snippet } = extractSnippet(r.bestChunk, primaryQuery, 300);
          return {
            docid: `#${r.docid}`,
            file: r.displayPath,
            title: r.title,
            score: Math.round(r.score * 100) / 100,
            context: r.context,
            snippet: addLineNumbers(snippet, line),
          };
        });

        nodeRes.writeHead(200, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ results: formatted }));
        log(`${ts()} POST /query ${params.searches.length} queries (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp" && nodeReq.method === "POST") {
        const rawBody = await collectBody(nodeReq);
        const body = JSON.parse(rawBody);
        const label = describeRequest(body);
        const url = `http://localhost:${port}${pathname}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // Route to existing session or create new one on initialize
        const sessionId = headers["mcp-session-id"];
        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            nodeRes.writeHead(404, { "Content-Type": "application/json" });
            nodeRes.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: body?.id ?? null,
            }));
            return;
          }
          transport = existing;
        } else if (isInitializeRequest(body)) {
          transport = await createSession();
        } else {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: body?.id ?? null,
          }));
          return;
        }

        const request = new Request(url, { method: "POST", headers, body: rawBody });
        const response = await transport.handleRequest(request, { parsedBody: body });

        nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        log(`${ts()} POST /mcp ${label} (${Date.now() - reqStart}ms)`);
        return;
      }

      if (pathname === "/mcp") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        // GET/DELETE must have a valid session
        const sessionId = headers["mcp-session-id"];
        if (!sessionId) {
          nodeRes.writeHead(400, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Missing session ID" },
            id: null,
          }));
          return;
        }
        const transport = sessions.get(sessionId);
        if (!transport) {
          nodeRes.writeHead(404, { "Content-Type": "application/json" });
          nodeRes.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          }));
          return;
        }

        const url = `http://localhost:${port}${pathname}`;
        const rawBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD" ? await collectBody(nodeReq) : undefined;
        const request = new Request(url, { method: nodeReq.method || "GET", headers, ...(rawBody ? { body: rawBody } : {}) });
        const response = await transport.handleRequest(request);
        nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        nodeRes.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      nodeRes.writeHead(404);
      nodeRes.end("Not Found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      nodeRes.writeHead(500);
      nodeRes.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, "localhost", () => resolve());
  });

  const actualPort = (httpServer.address() as import("net").AddressInfo).port;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const transport of sessions.values()) {
      await transport.close();
    }
    sessions.clear();
    httpServer.close();
    await store.close();
  };

  process.on("SIGTERM", async () => {
    console.error("Shutting down (SIGTERM)...");
    await stop();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.error("Shutting down (SIGINT)...");
    await stop();
    process.exit(0);
  });

  log(`QMD MCP server listening on http://localhost:${actualPort}/mcp`);
  return { httpServer, port: actualPort, stop };
}

// Run if this is the main module
if (fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1]?.endsWith("/server.ts") || process.argv[1]?.endsWith("/server.js")) {
  startMcpServer().catch(console.error);
}
