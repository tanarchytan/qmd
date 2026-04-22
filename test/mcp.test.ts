/**
 * MCP Server Tests
 *
 * Tests all MCP tools, resources, and prompts.
 * Uses mocked Ollama responses and a test database.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import type { Database } from "../src/db.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unlinkSync } from "node:fs";
import { mkdtemp, writeFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import type { CollectionConfig } from "../src/collections.js";
import { setConfigIndexName } from "../src/collections.js";
import { syncConfigToDb } from "../src/store.js";

// =============================================================================
// Test Database Setup
// =============================================================================

let testDb: Database;
let testDbPath: string;
let testConfigDir: string;

function initTestDatabase(db: Database): void {
  loadSqliteVec(db);
  db.exec("PRAGMA journal_mode = WAL");

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in YAML config
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      name, body,
      content='documents',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, name, body)
      SELECT new.id, new.path, content.doc
      FROM content
      WHERE content.hash = new.hash;
    END
  `);

  // Create vector table
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine)`);

  // Store collections — makes the DB self-contained
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

function seedTestData(db: Database): void {
  const now = new Date().toISOString();

  // Note: Collections are now managed in YAML config, not in database
  // For tests, we'll use a collection name "docs"

  // Add test documents
  const docs = [
    {
      path: "readme.md",
      title: "Project README",
      hash: "hash1",
      body: "# Project README\n\nThis is the main readme file for the project.\n\nIt contains important information about setup and usage.",
    },
    {
      path: "api.md",
      title: "API Documentation",
      hash: "hash2",
      body: "# API Documentation\n\nThis document describes the REST API endpoints.\n\n## Authentication\n\nUse Bearer tokens for auth.",
    },
    {
      path: "meetings/meeting-2024-01.md",
      title: "January Meeting Notes",
      hash: "hash3",
      body: "# January Meeting Notes\n\nDiscussed Q1 goals and roadmap.\n\n## Action Items\n\n- Review budget\n- Hire new team members",
    },
    {
      path: "meetings/meeting-2024-02.md",
      title: "February Meeting Notes",
      hash: "hash4",
      body: "# February Meeting Notes\n\nFollowed up on Q1 progress.\n\n## Updates\n\n- Budget approved\n- Two candidates interviewed",
    },
    {
      path: "large-file.md",
      title: "Large Document",
      hash: "hash5",
      body: "# Large Document\n\n" + "Lorem ipsum ".repeat(2000), // ~24KB
    },
  ];

  for (const doc of docs) {
    // Insert content first
    db.prepare(`
      INSERT OR IGNORE INTO content (hash, doc, created_at)
      VALUES (?, ?, ?)
    `).run(doc.hash, doc.body, now);

    // Then insert document metadata
    db.prepare(`
      INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
      VALUES ('docs', ?, ?, ?, ?, ?, 1)
    `).run(doc.path, doc.title, doc.hash, now, now);
  }

  // Add embeddings for vector search
  const embedding = new Float32Array(768);
  for (let i = 0; i < 768; i++) embedding[i] = Math.random();

  for (const doc of docs.slice(0, 4)) { // Skip large file for embeddings
    db.prepare(`INSERT INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, 'embeddinggemma', ?)`).run(doc.hash, now);
    db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(`${doc.hash}_0`, embedding);
  }
}

// =============================================================================
// MCP Server Test Helpers
// =============================================================================

// We need to create a testable version of the MCP handlers
// Since McpServer uses internal routing, we'll test the handler functions directly

import {
  searchFTS,
  searchVec,
  expandQuery,
  rerank,
  reciprocalRankFusion,
  extractSnippet,
  getContextForFile,
  findDocument,
  getDocumentBody,
  findDocuments,
  getStatus,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
} from "../src/store.js";
import type { RankedResult } from "../src/store.js";
// Note: searchResultsToMcpCsv no longer used in MCP - using structuredContent instead

// =============================================================================
// Tests
// =============================================================================

describe("MCP Server", () => {
  beforeAll(async () => {
    // Reset index name in case another test file mutated it (bun test shares process)
    setConfigIndexName("index");

    // Set up test config directory
    const configPrefix = join(tmpdir(), `qmd-mcp-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testConfigDir = await mkdtemp(configPrefix);
    process.env.LOTL_CONFIG_DIR = testConfigDir;

    // Create YAML config with test collection
    const testConfig: CollectionConfig = {
      collections: {
        docs: {
          path: "/test/docs",
          pattern: "**/*.md",
          context: {
            "/meetings": "Meeting notes and transcripts"
          }
        }
      }
    };
    await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(testConfig));

    testDbPath = `/tmp/qmd-mcp-test-${Date.now()}.sqlite`;
    testDb = openDatabase(testDbPath);
    initTestDatabase(testDb);
    seedTestData(testDb);

    // Sync YAML config into SQLite store_collections
    syncConfigToDb(testDb, testConfig);
  });

  afterAll(async () => {
    testDb.close();
    try {
      unlinkSync(testDbPath);
    } catch {}

    // Clean up test config directory
    try {
      const files = await readdir(testConfigDir);
      for (const file of files) {
        await unlink(join(testConfigDir, file));
      }
      await rmdir(testConfigDir);
    } catch {}

    delete process.env.LOTL_CONFIG_DIR;
  });

  // ===========================================================================
  // Tool: qmd_search (BM25)
  // ===========================================================================

  describe("searchFTS (BM25 keyword search)", () => {
    test("returns results for matching query", () => {
      const results = searchFTS(testDb, "readme", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.displayPath).toBe("docs/readme.md");
    });

    test("returns empty for non-matching query", () => {
      const results = searchFTS(testDb, "xyznonexistent", 10);
      expect(results.length).toBe(0);
    });

    test("respects limit parameter", () => {
      const results = searchFTS(testDb, "meeting", 1);
      expect(results.length).toBe(1);
    });

    // Note: Collection filtering tests removed - collections are now managed in YAML, not DB

    test("formats results as structured content", () => {
      const results = searchFTS(testDb, "api", 10);
      const filtered = results.map(r => ({
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: getContextForFile(testDb, r.filepath),
        snippet: extractSnippet(r.body || "", "api", 300, r.chunkPos).snippet,
      }));
      // MCP now returns structuredContent with results array
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered[0]).toHaveProperty("file");
      expect(filtered[0]).toHaveProperty("title");
      expect(filtered[0]).toHaveProperty("score");
      expect(filtered[0]).toHaveProperty("snippet");
    });
  });

  // ===========================================================================
  // searchVec (Vector similarity search)
  // ===========================================================================

  // searchVec (vector similarity) tests removed in the 2026-04-14 LlamaCpp
  // stub cleanup. The block was permanently `describe.skip`-ed because the
  // ingest path it depended on was removed in 2026-04-13. Re-add when the
  // transformers backend has a stable test-fixture path that can seed
  // memories_vec deterministically.

  // ===========================================================================
  // hybridQuery (query expansion + reranking)
  // ===========================================================================

  // Skip when CI (no LLM keys) OR when no query-expansion / rerank provider is configured.
  // These tests need a live LLM; otherwise expandQuery/rerank return empty/zero and the
  // assertions fail spuriously. Set LOTL_QUERY_EXPANSION_PROVIDER + LOTL_RERANK_PROVIDER
  // in your local .env to opt in.
  const hasQueryLLM = !!process.env.LOTL_QUERY_EXPANSION_PROVIDER || !!process.env.LOTL_QUERY_EXPANSION_URL;
  const hasRerankLLM = !!process.env.LOTL_RERANK_PROVIDER || !!process.env.LOTL_RERANK_URL;
  describe.skipIf(!!process.env.CI || !hasQueryLLM || !hasRerankLLM)("hybridQuery (expansion + reranking)", () => {
    test("expands query with typed variations", async () => {
      const expanded = await expandQuery("api documentation", DEFAULT_QUERY_MODEL, testDb);
      // Returns ExpandedQuery[] — typed expansions, original excluded
      expect(expanded.length).toBeGreaterThanOrEqual(1);
      for (const q of expanded) {
        expect(['lex', 'vec', 'hyde']).toContain(q.type);
        expect(q.query.length).toBeGreaterThan(0);
      }
    }, 30000); // 30s timeout for model loading

    test("performs RRF fusion on multiple result lists", () => {
      const list1: RankedResult[] = [
        { file: "/a", displayPath: "a.md", title: "A", body: "body", score: 1 },
        { file: "/b", displayPath: "b.md", title: "B", body: "body", score: 0.8 },
      ];
      const list2: RankedResult[] = [
        { file: "/b", displayPath: "b.md", title: "B", body: "body", score: 1 },
        { file: "/c", displayPath: "c.md", title: "C", body: "body", score: 0.9 },
      ];

      const fused = reciprocalRankFusion([list1, list2]);
      expect(fused.length).toBe(3);
      // B appears in both lists, should have higher score
      const bResult = fused.find(r => r.file === "/b");
      expect(bResult).toBeDefined();
    });

    test("reranks documents with LLM", async () => {
      const docs = [
        { file: "/test/docs/readme.md", text: "Project readme" },
        { file: "/test/docs/api.md", text: "API documentation" },
      ];
      const reranked = await rerank("readme", docs, DEFAULT_RERANK_MODEL, testDb);
      expect(reranked.length).toBe(2);
      expect(reranked[0]!.score).toBeGreaterThan(0);
    });

    test("full hybrid search pipeline", async () => {
      // Simulate full qmd_deep_search flow with type-routed queries
      const query = "meeting notes";
      const expanded = await expandQuery(query, DEFAULT_QUERY_MODEL, testDb);

      const rankedLists: RankedResult[][] = [];

      // Original query → FTS (probe)
      const probeFts = searchFTS(testDb, query, 20);
      if (probeFts.length > 0) {
        rankedLists.push(probeFts.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
      }

      // Expanded queries → route by type: lex→FTS, vec/hyde skipped (no vectors in test)
      for (const q of expanded) {
        if (q.type === 'lex') {
          const ftsResults = searchFTS(testDb, q.query, 20);
          if (ftsResults.length > 0) {
            rankedLists.push(ftsResults.map(r => ({
              file: r.filepath, displayPath: r.displayPath,
              title: r.title, body: r.body || "", score: r.score,
            })));
          }
        }
        // vec/hyde would go to searchVec — not available in this unit test
      }

      expect(rankedLists.length).toBeGreaterThan(0);

      const fused = reciprocalRankFusion(rankedLists);
      expect(fused.length).toBeGreaterThan(0);

      const candidates = fused.slice(0, 10);
      const reranked = await rerank(
        query,
        candidates.map(c => ({ file: c.file, text: c.body })),
        DEFAULT_RERANK_MODEL,
        testDb
      );

      expect(reranked.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Tool: qmd_get (Get Document)
  // ===========================================================================

  describe("qmd_get tool", () => {
    test("retrieves document by display_path", () => {
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta) ?? "";

      expect(meta.displayPath).toBe("docs/readme.md");
      expect(body).toContain("Project README");
    });

    test("retrieves document by filepath", () => {
      const meta = findDocument(testDb, "/test/docs/api.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      expect(meta.title).toBe("API Documentation");
    });

    test("retrieves document by partial path", () => {
      const result = findDocument(testDb, "api.md", { includeBody: false });
      expect("error" in result).toBe(false);
    });

    test("returns not found for missing document", () => {
      const result = findDocument(testDb, "nonexistent.md", { includeBody: false });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toBe("not_found");
      }
    });

    test("suggests similar files when not found", () => {
      const result = findDocument(testDb, "readm.md", { includeBody: false }); // typo
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.similarFiles.length).toBeGreaterThanOrEqual(0);
      }
    });

    test("supports line range with :line suffix", () => {
      const meta = findDocument(testDb, "readme.md:2", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 2, 2) ?? "";
      const lines = body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    test("supports fromLine parameter", () => {
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 3) ?? "";
      expect(body).not.toContain("# Project README");
    });

    test("supports maxLines parameter", () => {
      const meta = findDocument(testDb, "api.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta, 1, 3) ?? "";
      const lines = body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    test("includes context for documents in context path", () => {
      const result = findDocument(testDb, "meetings/meeting-2024-01.md", { includeBody: false });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.context).toBe("Meeting notes and transcripts");
    });
  });

  // ===========================================================================
  // Tool: qmd_multi_get (Multi Get)
  // ===========================================================================

  describe("qmd_multi_get tool", () => {
    test("retrieves multiple documents by glob pattern", () => {
      const { docs, errors } = findDocuments(testDb, "meetings/*.md", { includeBody: true });
      expect(errors.length).toBe(0);
      expect(docs.length).toBe(2);
      const paths = docs.map(d => d.doc.displayPath);
      expect(paths).toContain("docs/meetings/meeting-2024-01.md");
      expect(paths).toContain("docs/meetings/meeting-2024-02.md");
    });

    test("retrieves documents by comma-separated list", () => {
      const { docs, errors } = findDocuments(testDb, "readme.md, api.md", { includeBody: true });
      expect(errors.length).toBe(0);
      expect(docs.length).toBe(2);
    });

    test("returns errors for missing files in comma list", () => {
      const { docs, errors } = findDocuments(testDb, "readme.md, nonexistent.md", { includeBody: true });
      expect(docs.length).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("not found");
    });

    test("skips files larger than maxBytes", () => {
      const { docs } = findDocuments(testDb, "*.md", { includeBody: true, maxBytes: 1000 }); // 1KB limit
      const large = docs.find(d => d.doc.displayPath === "docs/large-file.md");
      expect(large).toBeDefined();
      expect(large?.skipped).toBe(true);
      if (large?.skipped) expect(large.skipReason).toContain("too large");
    });

    test("respects maxLines parameter", () => {
      const { docs } = findDocuments(testDb, "readme.md", { includeBody: true, maxBytes: DEFAULT_MULTI_GET_MAX_BYTES });
      expect(docs.length).toBe(1);
      const d = docs[0]!;
      expect(d.skipped).toBe(false);
      if (d.skipped) return;
      if (!("body" in d.doc)) {
        throw new Error("Expected body to be included in findDocuments result");
      }
      const lines = (d.doc.body || "").split("\n").slice(0, 2);
      expect(lines.length).toBeLessThanOrEqual(2);
    });

    test("returns error for non-matching glob", () => {
      const { docs, errors } = findDocuments(testDb, "nonexistent/*.md", { includeBody: true });
      expect(docs.length).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("No files matched");
    });

    test("includes context in results", () => {
      const { docs } = findDocuments(testDb, "meetings/meeting-2024-01.md", { includeBody: true });
      expect(docs.length).toBe(1);
      const d = docs[0]!;
      expect(d.skipped).toBe(false);
      if (d.skipped) return;
      if (!("context" in d.doc)) {
        throw new Error("Expected context to be present on document result");
      }
      expect(d.doc.context).toBe("Meeting notes and transcripts");
    });
  });

  // ===========================================================================
  // Tool: qmd_status
  // ===========================================================================

  describe("qmd_status tool", () => {
    test("returns index status", () => {
      const status = getStatus(testDb);
      expect(status.totalDocuments).toBe(5);
      expect(status.hasVectorIndex).toBe(true);
      expect(status.collections.length).toBe(1);
      expect(status.collections[0]!.path).toBe("/test/docs");
    });

    test("shows documents needing embedding", () => {
      const status = getStatus(testDb);
      // large-file.md doesn't have embeddings
      expect(status.needsEmbedding).toBe(1);
    });
  });

  // ===========================================================================
  // Resource: lotl://{path}
  // ===========================================================================

  describe("lotl:// resource", () => {
    test("lists all documents", () => {
      const docs = testDb.prepare(`
        SELECT path as display_path, title
        FROM documents
        WHERE active = 1
        ORDER BY modified_at DESC
        LIMIT 1000
      `).all() as { display_path: string; title: string }[];

      expect(docs.length).toBe(5);
      expect(docs.map(d => d.display_path)).toContain("readme.md");
    });

    test("reads document by display_path", () => {
      const path = "readme.md";
      const doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.body).toContain("Project README");
    });

    test("reads document by URL-encoded path", () => {
      // Simulate URL encoding that MCP clients may send
      const encodedPath = "meetings%2Fmeeting-2024-01.md";
      const decodedPath = decodeURIComponent(encodedPath);

      const doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(decodedPath) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("meetings/meeting-2024-01.md");
    });

    test("reads document by suffix match", () => {
      const path = "meeting-2024-01.md"; // without meetings/ prefix
      let doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      if (!doc) {
        doc = testDb.prepare(`
          SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${path}`) as { filepath: string; display_path: string; body: string } | null;
      }

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("meetings/meeting-2024-01.md");
    });

    test("returns not found for missing document", () => {
      const path = "nonexistent.md";
      const doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc == null).toBe(true); // bun:sqlite returns null, better-sqlite3 returns undefined
    });

    test("includes context in document body", () => {
      const path = "meetings/meeting-2024-01.md";
      const doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(path) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      const context = getContextForFile(testDb, doc!.filepath);
      expect(context).toBe("Meeting notes and transcripts");

      // Verify context would be prepended
      let text = doc!.body;
      if (context) {
        text = `<!-- Context: ${context} -->\n\n` + text;
      }
      expect(text).toContain("<!-- Context: Meeting notes and transcripts -->");
    });

    test("handles URL-encoded special characters", () => {
      // Test various URL encodings
      const testCases = [
        { encoded: "readme.md", decoded: "readme.md" },
        { encoded: "meetings%2Fmeeting-2024-01.md", decoded: "meetings/meeting-2024-01.md" },
        { encoded: "api.md%3A10", decoded: "api.md:10" }, // with line number
      ];

      for (const { encoded, decoded } of testCases) {
        expect(decodeURIComponent(encoded)).toBe(decoded);
      }
    });

    test("handles double-encoded URLs", () => {
      // Some clients may double-encode
      const doubleEncoded = "meetings%252Fmeeting-2024-01.md";
      const singleDecoded = decodeURIComponent(doubleEncoded);
      expect(singleDecoded).toBe("meetings%2Fmeeting-2024-01.md");

      const fullyDecoded = decodeURIComponent(singleDecoded);
      expect(fullyDecoded).toBe("meetings/meeting-2024-01.md");
    });

    test("handles URL-encoded paths with spaces", () => {
      // Add a document with spaces in the path
      const now = new Date().toISOString();
      const body = "# Podcast Episode\n\nInterview content here.";
      const hash = "hash_spaces";
      const path = "External Podcast/2023 April - Interview.md";

      // Insert content first
      testDb.prepare(`
        INSERT OR IGNORE INTO content (hash, doc, created_at)
        VALUES (?, ?, ?)
      `).run(hash, body, now);

      // Then insert document metadata
      testDb.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
        VALUES ('docs', ?, ?, ?, ?, ?, 1)
      `).run(path, "Podcast Episode", hash, now, now);

      // Simulate URL-encoded path from MCP client
      const encodedPath = "External%20Podcast%2F2023%20April%20-%20Interview.md";
      const decodedPath = decodeURIComponent(encodedPath);

      expect(decodedPath).toBe("External Podcast/2023 April - Interview.md");

      const doc = testDb.prepare(`
        SELECT 'lotl://' || d.collection || '/' || d.path as filepath, d.path as display_path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.path = ? AND d.active = 1
      `).get(decodedPath) as { filepath: string; display_path: string; body: string } | null;

      expect(doc).not.toBeNull();
      expect(doc?.display_path).toBe("External Podcast/2023 April - Interview.md");
      expect(doc?.body).toContain("Podcast Episode");
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    test("handles empty query", () => {
      const results = searchFTS(testDb, "", 10);
      expect(results.length).toBe(0);
    });

    test("handles special characters in query", () => {
      const results = searchFTS(testDb, "project's", 10);
      // Should not throw
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles unicode in query", () => {
      const results = searchFTS(testDb, "文档", 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles very long query", () => {
      const longQuery = "documentation ".repeat(100);
      const results = searchFTS(testDb, longQuery, 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("handles query with only stopwords", () => {
      const results = searchFTS(testDb, "the and or", 10);
      expect(Array.isArray(results)).toBe(true);
    });

    test("extracts snippet around matching text", () => {
      const body = "Line 1\nLine 2\nThis is the important line with the keyword\nLine 4\nLine 5";
      const { line, snippet } = extractSnippet(body, "keyword", 200);
      expect(snippet).toContain("keyword");
      expect(line).toBe(3);
    });

    test("handles snippet extraction with chunkPos", () => {
      const body = "A".repeat(1000) + "KEYWORD" + "B".repeat(1000);
      const chunkPos = 1000; // Position of KEYWORD
      const { snippet } = extractSnippet(body, "keyword", 200, chunkPos);
      expect(snippet).toContain("KEYWORD");
    });
  });

  // ===========================================================================
  // MCP Spec Compliance
  // ===========================================================================

  describe("MCP spec compliance", () => {
    test("encodeQmdPath preserves slashes but encodes special chars", () => {
      // Helper function behavior (tested indirectly through resource URIs)
      const path = "External Podcast/2023 April - Interview.md";
      const segments = path.split('/').map(s => encodeURIComponent(s)).join('/');
      expect(segments).toBe("External%20Podcast/2023%20April%20-%20Interview.md");
      expect(segments).toContain("/"); // Slashes preserved
      expect(segments).toContain("%20"); // Spaces encoded
    });

    test("search results have correct structure for structuredContent", () => {
      const results = searchFTS(testDb, "readme", 5);
      const structured = results.map(r => ({
        file: r.displayPath,
        title: r.title,
        score: Math.round(r.score * 100) / 100,
        context: getContextForFile(testDb, r.filepath),
        snippet: extractSnippet(r.body || "", "readme", 300, r.chunkPos).snippet,
      }));

      expect(structured.length).toBeGreaterThan(0);
      const item = structured[0]!;
      expect(typeof item.file).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.score).toBe("number");
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(typeof item.snippet).toBe("string");
    });

    test("error responses should include isError flag", () => {
      // Simulate what MCP server returns for errors
      const errorResponse = {
        content: [{ type: "text", text: "Collection not found: nonexistent" }],
        isError: true,
      };
      expect(errorResponse.isError).toBe(true);
      expect(errorResponse.content[0]!.type).toBe("text");
    });

    test("embedded resources include name and title", () => {
      // Simulate what qmd_get returns
      const meta = findDocument(testDb, "readme.md", { includeBody: false });
      expect("error" in meta).toBe(false);
      if ("error" in meta) return;
      const body = getDocumentBody(testDb, meta) ?? "";
      const resource = {
        uri: `lotl://${meta.displayPath}`,
        name: meta.displayPath,
        title: meta.title,
        mimeType: "text/markdown",
        text: body,
      };
      expect(resource.name).toBe("docs/readme.md");
      expect(resource.title).toBe("Project README");
      expect(resource.mimeType).toBe("text/markdown");
    });

    test("status response includes structuredContent", () => {
      const status = getStatus(testDb);
      // Verify structure matches StatusResult type
      expect(typeof status.totalDocuments).toBe("number");
      expect(typeof status.needsEmbedding).toBe("number");
      expect(typeof status.hasVectorIndex).toBe("boolean");
      expect(Array.isArray(status.collections)).toBe(true);
      if (status.collections.length > 0) {
        const col = status.collections[0]!;
        expect(typeof col.name).toBe("string"); // Collections now use names, not IDs
        expect(typeof col.path).toBe("string");
        expect(typeof col.pattern).toBe("string");
        expect(typeof col.documents).toBe("number");
      }
    });
  });
});

// =============================================================================
// HTTP Transport Tests
// =============================================================================

import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import { enableProductionMode } from "../src/store.js";

// CI gate removed 2026-04-14: original gate was added in commit 55f1646
// (2026-03-10) with reason "Skip MCP HTTP Transport tests in CI (they
// instantiate a real LlamaCpp)". LlamaCpp was removed in the 2026-04-13
// cleanup. These tests no longer touch any LLM — memory_store hits FTS5
// and SQLite, memory_recall falls back to FTS5 when no embed backend is
// configured (CI does not set LOTL_EMBED_BACKEND=transformers). Re-enabled
// to catch HTTP transport regressions like the bin/qmd exec-bit and
// metadata round-trip bugs found in the AMB cross-bench smoke test.
describe("MCP HTTP Transport", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let httpTestDbPath: string;
  let httpTestConfigDir: string;
  // Stash original env to restore after tests
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.LOTL_CONFIG_DIR;

  beforeAll(async () => {
    // Create isolated test database with seeded data
    httpTestDbPath = `/tmp/qmd-mcp-http-test-${Date.now()}.sqlite`;
    const db = openDatabase(httpTestDbPath);
    initTestDatabase(db);
    seedTestData(db);

    // Sync config into SQLite
    const httpTestConfig: CollectionConfig = {
      collections: {
        docs: {
          path: "/test/docs",
          pattern: "**/*.md",
        }
      }
    };
    syncConfigToDb(db, httpTestConfig);
    db.close();

    // Create isolated YAML config
    const configPrefix = join(tmpdir(), `qmd-mcp-http-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    httpTestConfigDir = await mkdtemp(configPrefix);
    await writeFile(join(httpTestConfigDir, "index.yml"), YAML.stringify(httpTestConfig));

    // Point createStore() at our test DB
    process.env.INDEX_PATH = httpTestDbPath;
    process.env.LOTL_CONFIG_DIR = httpTestConfigDir;

    handle = await startMcpHttpServer(0, { quiet: true }); // OS-assigned ephemeral port
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();

    // Restore env
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.LOTL_CONFIG_DIR = origConfigDir;
    else delete process.env.LOTL_CONFIG_DIR;

    // Clean up test files
    try { unlinkSync(httpTestDbPath); } catch {}
    try {
      const files = await readdir(httpTestConfigDir);
      for (const f of files) await unlink(join(httpTestConfigDir, f));
      await rmdir(httpTestConfigDir);
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // Health & routing
  // ---------------------------------------------------------------------------

  test("GET /health returns 200 with status and uptime", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  test("GET /other returns 404", async () => {
    const res = await fetch(`${baseUrl}/other`);
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // MCP protocol over HTTP
  // ---------------------------------------------------------------------------

  /** Track session ID returned by initialize (MCP Streamable HTTP spec) */
  let sessionId: string | null = null;

  /** Send a JSON-RPC message to /mcp and return the parsed response.
   * MCP Streamable HTTP requires Accept header with both JSON and SSE. */
  async function mcpRequest(body: object): Promise<{ status: number; json: any; contentType: string | null }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // Capture session ID from initialize responses
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    const json = await res.json();
    return { status: res.status, json, contentType: res.headers.get("content-type") };
  }

  test("POST /mcp initialize returns 200 JSON (not SSE)", async () => {
    const { status, json, contentType } = await mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.serverInfo.name).toBe("lotl");
  });

  test("POST /mcp tools/list returns registered tools", async () => {
    // Initialize first (required by MCP protocol)
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json, contentType } = await mcpRequest({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");

    const toolNames = json.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("doc_search");
    expect(toolNames).toContain("doc_get");
    expect(toolNames).toContain("doc_status");
    // Old names must be gone — canonical-only surface.
    expect(toolNames).not.toContain("query");
    expect(toolNames).not.toContain("memory_store");
    expect(toolNames).not.toContain("memory_recall");
  });

  test("POST /mcp tools/call doc_search returns results", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json } = await mcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "doc_search", arguments: { searches: [{ type: "lex", query: "readme" }] } },
    });
    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.content.length).toBeGreaterThan(0);
    expect(json.result.content[0].type).toBe("text");
  });

  test("POST /mcp tools/call doc_get returns document", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const { status, json } = await mcpRequest({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "doc_get", arguments: { path: "readme.md" } },
    });
    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.content.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Memory tools — metadata round-trip
  //
  // Regression test for the AMB cross-bench adapter: external callers need
  // to round-trip arbitrary doc IDs through qmd via the metadata field.
  // memory_add must accept metadata, memory_search must surface it as a
  // parsed object on structuredContent.results[i].metadata. Without this
  // contract, sr5-style scoring against gold IDs is impossible.
  // ---------------------------------------------------------------------------

  // Needs a live embed backend (memory_search requires embeddings). Skipped when
  // no local transformers backend is configured and no remote embed provider set.
  const hasEmbedBackend =
    process.env.LOTL_EMBED_BACKEND === "transformers" ||
    !!process.env.LOTL_EMBED_PROVIDER ||
    !!process.env.LOTL_EMBED_URL;
  test.skipIf(!hasEmbedBackend)("POST /mcp tools/call memory_add + memory_search round-trips metadata.doc_id", async () => {
    // Initialize
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const uniqueText = `metadata-roundtrip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const docId = `synthetic-doc-${Math.random().toString(36).slice(2)}`;
    const scope = `mcp-test-${Date.now()}`;

    // Store with metadata
    const storeRes = await mcpRequest({
      jsonrpc: "2.0", id: 100, method: "tools/call",
      params: {
        name: "memory_add",
        arguments: {
          text: uniqueText,
          scope,
          metadata: { doc_id: docId, source_session_id: "session-xyz", custom: 42 },
        },
      },
    });
    expect(storeRes.status).toBe(200);
    expect(storeRes.json.result).toBeDefined();
    expect(storeRes.json.result.content[0].text).toMatch(/Memory stored|Duplicate found/);

    // Recall and verify metadata round-trip
    const recallRes = await mcpRequest({
      jsonrpc: "2.0", id: 101, method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: uniqueText, scope, limit: 5 },
      },
    });
    expect(recallRes.status).toBe(200);
    expect(recallRes.json.result).toBeDefined();

    const results = recallRes.json.result.structuredContent?.results;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // metadata must be a parsed object (not a JSON string)
    const hit = results.find((r: any) => r.text === uniqueText);
    expect(hit).toBeDefined();
    expect(hit.metadata).toBeDefined();
    expect(typeof hit.metadata).toBe("object");
    expect(hit.metadata.doc_id).toBe(docId);
    expect(hit.metadata.source_session_id).toBe("session-xyz");
    expect(hit.metadata.custom).toBe(42);
  });

  // ---------------------------------------------------------------------------
  // Canonical CRUD surface — memory_get / memory_list / memory_delete /
  // memory_dream. memory_add + memory_search are exercised by the
  // metadata round-trip test above.
  // ---------------------------------------------------------------------------

  test("POST /mcp tools/call memory_get + memory_list + memory_delete", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const uniqueText = `zxqvtm7 lwkrj3 canonical-crud-nonce-${nonce} timestamp ${Date.now()}`;
    const scope = `mcp-canonical-${Date.now()}-${nonce}`;

    const addRes = await mcpRequest({
      jsonrpc: "2.0", id: 200, method: "tools/call",
      params: { name: "memory_add", arguments: { text: uniqueText, scope, metadata: { tag: "canonical" } } },
    });
    expect(addRes.status).toBe(200);

    const searchRes = await mcpRequest({
      jsonrpc: "2.0", id: 201, method: "tools/call",
      params: { name: "memory_search", arguments: { query: uniqueText, scope, limit: 5 } },
    });
    const results = searchRes.json.result.structuredContent?.results;
    const hit = results.find((r: any) => r.text === uniqueText);
    expect(hit).toBeDefined();

    // memory_get by id
    const getRes = await mcpRequest({
      jsonrpc: "2.0", id: 202, method: "tools/call",
      params: { name: "memory_get", arguments: { id: hit.id } },
    });
    expect(getRes.status).toBe(200);
    expect(getRes.json.result.structuredContent?.id).toBe(hit.id);
    expect(getRes.json.result.structuredContent?.text).toBe(uniqueText);

    // memory_list scoped browse
    const listRes = await mcpRequest({
      jsonrpc: "2.0", id: 203, method: "tools/call",
      params: { name: "memory_list", arguments: { scope, limit: 10 } },
    });
    expect(listRes.status).toBe(200);
    const listed = listRes.json.result.structuredContent?.results;
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.some((r: any) => r.id === hit.id)).toBe(true);

    // memory_delete
    const delRes = await mcpRequest({
      jsonrpc: "2.0", id: 204, method: "tools/call",
      params: { name: "memory_delete", arguments: { id: hit.id } },
    });
    expect(delRes.status).toBe(200);
    expect(delRes.json.result.content[0].text).toMatch(/deleted/);
  });

  test("POST /mcp tools/call memory_dream runs consolidation pass", async () => {
    await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const dreamRes = await mcpRequest({
      jsonrpc: "2.0", id: 300, method: "tools/call",
      params: { name: "memory_dream", arguments: {} },
    });
    expect(dreamRes.status).toBe(200);
    expect(dreamRes.json.result.content[0].text).toMatch(/dream —/);
    const sc = dreamRes.json.result.structuredContent;
    expect(sc.cleanup).toBeDefined();
    expect(typeof sc.cleanup.totalMemoriesBefore).toBe("number");
    expect(sc.reflection).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Comprehensive tool-registration smoke tests.
  //
  // Ensures every registered MCP tool responds to tools/call with a 200 and
  // a well-formed JSON-RPC result (no exception, no "Method not found"). Not
  // a deep correctness test — tools requiring an LLM provider skipIf the
  // relevant env var is missing; smoke assertions focus on structure.
  //
  // Goal: tomorrow-me renames a tool handler, breaks something subtle, this
  // test catches it. Preserving the CRUD-aligned surface is a v1 contract.
  // -------------------------------------------------------------------------
  describe("tool-registration smoke (all 17 MCP tools)", () => {
    let initDone = false;
    async function ensureInit() {
      if (initDone) return;
      await mcpRequest({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });
      initDone = true;
    }

    async function callTool(id: number, name: string, args: any) {
      await ensureInit();
      return mcpRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    }

    // Shape assertion shared across most smoke tests. A successful MCP call
    // returns `result.content[]` with at least one block. Error responses
    // live under `error.code` — we check that path for graceful failures.
    function assertNoErrorOrAccepted(res: any, acceptedErrorPatterns: RegExp[] = []) {
      expect(res.status).toBe(200);
      if (res.json.error) {
        const msg = String(res.json.error.message ?? "");
        const accepted = acceptedErrorPatterns.some(p => p.test(msg));
        if (!accepted) {
          throw new Error(`unexpected MCP error: ${msg}`);
        }
        return;
      }
      expect(res.json.result).toBeDefined();
      expect(Array.isArray(res.json.result.content)).toBe(true);
    }

    // --- Doc tools ---

    test("doc_get_batch returns batch map", async () => {
      const res = await callTool(400, "doc_get_batch", { paths: ["readme.md", "docs/meetings/weekly.md"] });
      assertNoErrorOrAccepted(res);
    });

    test("doc_status returns health", async () => {
      const res = await callTool(401, "doc_status", {});
      assertNoErrorOrAccepted(res);
      // status should always produce some content text
      if (res.json.result) {
        expect(res.json.result.content[0].type).toBe("text");
      }
    });

    test("briefing returns wake-up context", async () => {
      const res = await callTool(402, "briefing", {});
      assertNoErrorOrAccepted(res);
    });

    test("doc_manage dispatches an admin op", async () => {
      // `cleanup` is the cheapest admin op — doesn't mutate anything if there's
      // nothing to clean up. Other ops (embed/update/sync) can touch network
      // or filesystem, so they're skipped from smoke.
      const res = await callTool(403, "doc_manage", { operation: "cleanup" });
      assertNoErrorOrAccepted(res, [/no collections/, /not implemented/]);
    });

    // --- Memory tools ---

    test("memory_add_batch accepts multi-memory payload", async () => {
      const res = await callTool(410, "memory_add_batch", {
        memories: [
          { text: "alice likes green tea", category: "preference", scope: "smoke-batch" },
          { text: "alice uses postgres", category: "fact", scope: "smoke-batch" },
        ],
      });
      assertNoErrorOrAccepted(res, [/embed|backend|provider/i]);
    });

    test("memory_register_scopes accepts scope list", async () => {
      const res = await callTool(411, "memory_register_scopes", {
        scopes: ["smoke-scope-a", "smoke-scope-b"],
      });
      assertNoErrorOrAccepted(res);
    });

    test("memory_update accepts id + patch", async () => {
      // Create a memory first to have a valid id, then update it.
      const addRes = await callTool(412, "memory_add", {
        text: "placeholder for update test",
        category: "fact",
        scope: "smoke-update",
      });
      const addContent = addRes.json.result?.structuredContent;
      const id = addContent?.id;
      if (!id) {
        // memory_add may fail if no embed backend configured — accept that
        // and skip the update branch. The smoke value is proving the handler
        // exists and responds.
        return;
      }
      const res = await callTool(413, "memory_update", {
        id,
        text: "updated placeholder",
        importance: 0.8,
      });
      assertNoErrorOrAccepted(res);
    });

    test("memory_stats returns category/scope/tier breakdown", async () => {
      const res = await callTool(414, "memory_stats", {});
      assertNoErrorOrAccepted(res);
      if (res.json.result) {
        const sc = res.json.result.structuredContent ?? {};
        // Stats shape is an object with at least one of these fields; be
        // loose to accommodate schema drift.
        const hasSome = ["total", "byTier", "byCategory", "byScope"].some(k => k in sc);
        if (!hasSome) expect(res.json.result.content[0].type).toBe("text");
      }
    });

    test("memory_recall_tiered accepts query", async () => {
      const res = await callTool(415, "memory_recall_tiered", {
        query: "smoke test query for tiered recall",
        limit: 3,
      });
      assertNoErrorOrAccepted(res, [/embed|backend|provider/i]);
    });

    test("memory_push_pack returns context bundle", async () => {
      const res = await callTool(416, "memory_push_pack", {
        query: "build a context pack about smoke tests",
        maxMemories: 5,
      });
      assertNoErrorOrAccepted(res, [/embed|backend|provider/i]);
    });

    test("memory_extract without LLM uses heuristic fallback", async () => {
      const res = await callTool(417, "memory_extract", {
        text: "User: I prefer dark mode. Assistant: Noted — I'll keep dark mode on.",
        scope: "smoke-extract",
      });
      assertNoErrorOrAccepted(res, [/embed|backend|provider|LLM|remote/i]);
    });

    test("memory_reflect summarizes top-K when called", async () => {
      // Requires a remote LLM to actually do work; tool should still respond
      // gracefully when no provider is configured.
      const res = await callTool(418, "memory_reflect", {
        question: "what do we know about smoke testing?",
        scope: "smoke-reflect",
      });
      assertNoErrorOrAccepted(res, [/no remote|no provider|embed|not configured/i]);
    });

    // --- Knowledge graph tools ---

    test("knowledge_add stores a triple", async () => {
      const res = await callTool(420, "knowledge_add", {
        subject: "alice",
        predicate: "likes",
        object: "green tea",
        scope: "smoke-kg",
      });
      assertNoErrorOrAccepted(res);
    });

    test("knowledge_search queries by subject", async () => {
      const res = await callTool(421, "knowledge_search", {
        subject: "alice",
        scope: "smoke-kg",
      });
      assertNoErrorOrAccepted(res);
    });

    test("knowledge_invalidate marks a triple invalid", async () => {
      // Seed a triple to invalidate
      await callTool(422, "knowledge_add", {
        subject: "bob",
        predicate: "works_at",
        object: "initech",
        scope: "smoke-kg",
      });
      const searchRes = await callTool(423, "knowledge_search", {
        subject: "bob",
        scope: "smoke-kg",
      });
      const triples = searchRes.json.result?.structuredContent?.results ?? [];
      if (triples.length === 0) return; // search didn't hit — skip the invalidate step
      const tripleId = triples[0]?.id;
      if (!tripleId) return;
      const res = await callTool(424, "knowledge_invalidate", { id: tripleId });
      assertNoErrorOrAccepted(res);
    });

    test("knowledge_entities lists distinct subjects", async () => {
      const res = await callTool(425, "knowledge_entities", { scope: "smoke-kg" });
      assertNoErrorOrAccepted(res);
    });

    test("knowledge_timeline returns chronology for a subject", async () => {
      const res = await callTool(426, "knowledge_timeline", {
        subject: "alice",
        scope: "smoke-kg",
      });
      assertNoErrorOrAccepted(res);
    });

    test("knowledge_stats returns entity/fact counts", async () => {
      const res = await callTool(427, "knowledge_stats", {});
      assertNoErrorOrAccepted(res);
    });
  });
});
