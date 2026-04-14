/**
 * memory/index.ts — Conversation memory layer for QMD.
 *
 * Stores and retrieves agent memories alongside document search.
 * Same SQLite DB, same embed/rerank providers, same search pipeline.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { getRemoteConfig, getRemoteLLM } from "../remote-config.js";
// LlamaCpp removed in 2026-04-13 cleanup — local embed is now via
// TransformersEmbedBackend (loaded via getFastEmbedBackend below).
import { getDecayScore } from "./decay.js";
import { classifyMemory } from "./patterns.js";
import { knowledgeQuery, type KnowledgeEntry } from "./knowledge.js";

// =============================================================================
// Embedding LRU cache — avoids redundant API calls for repeated text
// From Mastra: keyed by content hash, 100 entry max
// =============================================================================

const EMBED_CACHE_MAX = 100;
const embedCache = new Map<string, number[]>();

function getCachedEmbedding(text: string): number[] | undefined {
  const key = createHash("md5").update(text).digest("hex");
  return embedCache.get(key);
}

function setCachedEmbedding(text: string, embedding: number[]): void {
  const key = createHash("md5").update(text).digest("hex");
  if (embedCache.size >= EMBED_CACHE_MAX) {
    // Evict oldest entry
    const firstKey = embedCache.keys().next().value;
    if (firstKey) embedCache.delete(firstKey);
  }
  embedCache.set(key, embedding);
}
export { runDecayPass, runEvictionPass, runCleanupPass, type DecayResult, type EvictionResult, type EvictionOptions, type CleanupOptions, type CleanupResult } from "./decay.js";
import { extractAndStore as _extractAndStore, extractReflections as _extractReflections, type ExtractionResult } from "./extractor.js";
export type { ExtractionResult } from "./extractor.js";

/** Wrapper that injects memoryStore + knowledgeStore to break circular import */
export async function extractAndStore(db: Database, text: string, scope?: string): Promise<ExtractionResult> {
  return _extractAndStore(db, text, scope, memoryStore, knowledgeStore);
}

/** Reflection extraction wrapper — see extractor.extractReflections */
export async function extractReflections(db: Database, text: string, scope?: string) {
  return _extractReflections(db, text, scope, memoryStore);
}
export { classifyMemory, extractPreferences, hasMemorySignal } from "./patterns.js";
import { knowledgeStore, consolidateEntityFacts as _consolidateEntityFacts } from "./knowledge.js";
export { knowledgeStore, knowledgeQuery, knowledgeInvalidate, knowledgeEntities, knowledgeAbout, knowledgeTimeline, knowledgeStats, toSlug } from "./knowledge.js";

/** Per-entity fact consolidation — wraps memoryStore to break circular import. */
export async function consolidateEntityFacts(db: Database, options?: { scope?: string; minFacts?: number }) {
  return _consolidateEntityFacts(db, memoryStore, options);
}
export { importConversation, exportMemories, importMemories } from "./import.js";
// =============================================================================
// Types
// =============================================================================

export const MEMORY_CATEGORIES = [
  "preference", "fact", "decision", "entity", "reflection", "other",
] as const;
export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export type Memory = {
  id: string;
  text: string;
  content_hash: string;
  category: MemoryCategory;
  scope: string;
  importance: number;
  tier: string;
  access_count: number;
  created_at: number;
  last_accessed: number | null;
  metadata: string | null;
};

export type MemoryStoreOptions = {
  text: string;
  category?: MemoryCategory;
  scope?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
};

export type MemoryTier = "peripheral" | "working" | "core";

export type MemoryRecallOptions = {
  query: string;
  scope?: string;
  category?: MemoryCategory;
  /**
   * Restrict retrieval to a specific tier or set of tiers. When omitted,
   * all tiers are eligible. Used by tier-aware callers (Zep-style
   * agents querying "working" or "episodic" memory explicitly).
   */
  tier?: MemoryTier | MemoryTier[];
  limit?: number;
  rerank?: boolean;
};

export type MemoryRecallResult = {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  score: number;
  created_at: number;
  /** JSON-serialized metadata as stored. Use parseMemoryMetadata() to read structured fields. */
  metadata?: string | null;
};

export type MemoryUpdateOptions = {
  id: string;
  text?: string;
  importance?: number;
  category?: MemoryCategory;
  metadata?: Record<string, unknown>;
};

// =============================================================================
// Content hash for fast dedup
// =============================================================================

function contentHash(text: string): string {
  return createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

// =============================================================================
// Stop words for keyword boost (from MemPalace benchmarks)
// =============================================================================

const STOP_WORDS = new Set([
  // Question words
  "what", "when", "where", "who", "how", "which", "why",
  // Copulas + auxiliaries
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "did", "does", "done", "have", "has", "had",
  "will", "would", "could", "should", "can", "may", "might", "shall",
  // Pronouns
  "i", "me", "my", "you", "your", "he", "him", "his", "she", "her",
  "it", "its", "we", "us", "our", "they", "them", "their",
  "these", "those", "this", "that",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "into", "over", "after", "before", "between", "through", "during",
  "above", "below", "up", "down", "out", "off", "under",
  // Articles + conjunctions
  "the", "a", "an", "and", "or", "but", "nor", "so", "as", "if",
  "while", "although", "though", "until", "unless", "because",
  // Common verbs (too generic)
  "go", "going", "went", "gone", "get", "got", "getting",
  "give", "gave", "buy", "bought", "made", "make",
  "like", "likely",
  // Adverbs + quantifiers
  "not", "no", "very", "just", "also", "too", "than",
  "some", "any", "all", "each", "every", "both", "few",
  "more", "most", "other", "such", "only", "same",
  "again", "further", "then", "once", "here", "there", "about",
  "still", "already", "yet", "even", "much", "many",
  // Temporal (handled by temporal boost instead)
  "ago", "last", "long",
]);

function extractKeywords(text: string): string[] {
  // MemPalace hybrid_v5 finding: remove speaker/person names from keyword boost.
  // Names match too many memories, drowning predicate-level signal.
  // Filter: skip capitalized words from original text (likely names/entities).
  const nameWords = new Set(
    text.split(/\s+/)
      .filter(w => /^[A-Z][a-z]+$/.test(w))
      .map(w => w.toLowerCase())
  );
  return text.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !nameWords.has(w));
}

// =============================================================================
// Temporal reference parsing (from MemPalace HYBRID_MODE.md)
// Detects "N days/weeks/months ago", "last week", "recently" etc.
// =============================================================================

type TimeReference = { targetMs: number; windowDays: number };

function parseTimeReference(query: string): TimeReference | null {
  const now = Date.now();
  const MS_PER_DAY = 86400000;
  const lower = query.toLowerCase();

  // "N days ago"
  let match = lower.match(/(\d+)\s*days?\s*ago/);
  if (match) return { targetMs: now - parseInt(match[1]!) * MS_PER_DAY, windowDays: 3 };

  // "a couple of days ago"
  if (/a couple of days ago/.test(lower)) return { targetMs: now - 2 * MS_PER_DAY, windowDays: 2 };

  // "N weeks ago"
  match = lower.match(/(\d+)\s*weeks?\s*ago/);
  if (match) return { targetMs: now - parseInt(match[1]!) * 7 * MS_PER_DAY, windowDays: 7 };

  // "a week ago" / "last week"
  if (/(?:a week ago|last week)/.test(lower)) return { targetMs: now - 7 * MS_PER_DAY, windowDays: 7 };

  // "N months ago"
  match = lower.match(/(\d+)\s*months?\s*ago/);
  if (match) return { targetMs: now - parseInt(match[1]!) * 30 * MS_PER_DAY, windowDays: 14 };

  // "a month ago" / "last month"
  if (/(?:a month ago|last month)/.test(lower)) return { targetMs: now - 30 * MS_PER_DAY, windowDays: 14 };

  // "yesterday"
  if (/yesterday/.test(lower)) return { targetMs: now - MS_PER_DAY, windowDays: 1 };

  // "recently" / "the other day"
  if (/(?:recently|the other day)/.test(lower)) return { targetMs: now - 3 * MS_PER_DAY, windowDays: 7 };

  return null;
}

// =============================================================================
// Embed helper — opt-in transformers.js ONNX backend, else remote, else null.
// Gated by QMD_EMBED_BACKEND=transformers to avoid loading the native
// onnxruntime-node binding (and its sharp dep) for callers that only want
// FTS + remote. The native binding can crash on some Windows test envs.
// =============================================================================
let _onnxBackend: any = null;
async function getFastEmbedBackend(): Promise<any> {
  if (process.env.QMD_EMBED_BACKEND !== "transformers") return null;
  if (_onnxBackend) return _onnxBackend;
  try {
    const mod = await import("../llm/transformers-embed.js");
    _onnxBackend = await mod.createTransformersEmbedBackend();
    return _onnxBackend;
  } catch (err) {
    process.stderr.write(`transformers embed backend load failed: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

async function embedText(text: string): Promise<number[] | null> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const fe = await getFastEmbedBackend();
  if (fe) {
    try {
      const result = await fe.embed(text);
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch (err) {
      process.stderr.write(`local embed failed: ${err instanceof Error ? err.message : err}\n`);
      return null;
    }
  }

  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.embed) {
    try {
      const remote = getRemoteLLM()!;
      const result = await remote.embed(text, { isQuery: false });
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch (err) {
      process.stderr.write(`Memory embed failed: ${err instanceof Error ? err.message : err}\n`);
      return null;
    }
  }
  return null;
}

/**
 * Batch embed N texts in one round trip when the provider supports it.
 * Falls back to per-text embedText() if no batch API is available.
 * Cache hits short-circuit before the network call.
 */
async function embedTextBatch(texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const missingIdx: number[] = [];
  const missingTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = getCachedEmbedding(texts[i]!);
    if (cached) out[i] = cached;
    else { missingIdx.push(i); missingTexts.push(texts[i]!); }
  }
  if (missingTexts.length === 0) return out;

  const fe = await getFastEmbedBackend();
  if (fe) {
    try {
      const results = await fe.embedBatch(missingTexts);
      for (let j = 0; j < missingTexts.length; j++) {
        const emb = results[j]?.embedding || null;
        out[missingIdx[j]!] = emb;
        if (emb) setCachedEmbedding(missingTexts[j]!, emb);
      }
      return out;
    } catch (err) {
      process.stderr.write(`local embedBatch failed, falling back: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.embed) {
    try {
      const remote = getRemoteLLM()!;
      const results = await remote.embedBatch(missingTexts);
      for (let j = 0; j < missingTexts.length; j++) {
        const emb = results[j]?.embedding || null;
        out[missingIdx[j]!] = emb;
        if (emb) setCachedEmbedding(missingTexts[j]!, emb);
      }
      return out;
    } catch (err) {
      process.stderr.write(`Memory embedBatch failed, falling back to per-item: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  // Fallback: per-text (handles local LLM and embed-batch failures)
  for (let j = 0; j < missingTexts.length; j++) {
    out[missingIdx[j]!] = await embedText(missingTexts[j]!);
  }
  return out;
}

async function embedQuery(text: string): Promise<number[] | null> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const fe = await getFastEmbedBackend();
  if (fe) {
    try {
      const result = await fe.embed(text);
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch (err) {
      process.stderr.write(`local embed query failed: ${err instanceof Error ? err.message : err}\n`);
      return null;
    }
  }

  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.embed) {
    try {
      const remote = getRemoteLLM()!;
      const result = await remote.embed(text, { isQuery: true });
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch (err) {
      process.stderr.write(`Memory query embed failed: ${err instanceof Error ? err.message : err}\n`);
      return null;
    }
  }
  return null;
}

// =============================================================================
// Ensure memories_vec table (dynamic dimensions, scope-partitioned vec0)
// =============================================================================
//
// memories_vec is created with `scope TEXT PARTITION KEY` so sqlite-vec
// walks only the current scope's slice of the index when a recall query
// passes WHERE scope = ?. Without partitioning, the KNN query returns
// the K nearest memories across the *entire* table and we have to drop
// non-scope hits in post-processing — which on a shared-DB benchmark
// like LME _s n=500 (500 scopes × ~50 memories) leaves only ~K/scopes
// memories per query after the filter.
//
// Existing pre-partition databases are auto-migrated by detecting the
// missing partition column and dropping/recreating the table. The
// caller (memoryStore / memoryStoreBatch) re-inserts on next write.

let _memoriesVecInitialized = false;
let _memoriesVecHasPartition = false;

function ensureMemoriesVecTable(db: Database, dimensions: number): void {
  if (_memoriesVecInitialized) return;
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'`
  ).get() as { sql: string } | null;
  if (tableInfo) {
    const dimMatch = tableInfo.sql.match(/float\[(\d+)\]/);
    const existingDims = dimMatch?.[1] ? parseInt(dimMatch[1], 10) : null;
    const hasPartition = /partition\s+key/i.test(tableInfo.sql);
    if (existingDims === dimensions && hasPartition) {
      _memoriesVecInitialized = true;
      _memoriesVecHasPartition = true;
      return;
    }
    // Dimension mismatch OR missing partition column — drop and recreate.
    db.exec(`DROP TABLE IF EXISTS memories_vec`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`
  );
  _memoriesVecInitialized = true;
  _memoriesVecHasPartition = true;
}

// =============================================================================
// Cosine dedup check
// =============================================================================

function findSimilarMemory(db: Database, embedding: number[], threshold: number = 0.9): { id: string; score: number } | null {
  try {
    const results = db.prepare(
      `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = 5`
    ).all(new Float32Array(embedding)) as { id: string; distance: number }[];
    for (const r of results) {
      const similarity = 1 - r.distance;
      if (similarity >= threshold) {
        return { id: r.id, score: similarity };
      }
    }
  } catch {
    // memories_vec may not exist yet
  }
  return null;
}

// =============================================================================
// Memory CRUD
// =============================================================================

export async function memoryStore(
  db: Database,
  options: MemoryStoreOptions
): Promise<{ id: string; status: "created" | "duplicate"; duplicate_id?: string }> {
  const text = options.text.trim();
  if (!text) throw new Error("Memory text cannot be empty");

  const hash = contentHash(text);
  const category = options.category || classifyMemory(text);
  const scope = options.scope || "global";
  const importance = Math.max(0, Math.min(1, options.importance ?? 0.5));
  const now = Date.now();

  // Fast dedup: exact content hash match
  const existing = db.prepare(
    `SELECT id FROM memories WHERE content_hash = ?`
  ).get(hash) as { id: string } | null;
  if (existing) {
    // Touch access count
    db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`).run(now, existing.id);
    return { id: existing.id, status: "duplicate", duplicate_id: existing.id };
  }

  // Embed for vector dedup + storage
  const embedding = await embedText(text);

  // Cosine dedup: near-duplicate check
  if (embedding) {
    const similar = findSimilarMemory(db, embedding, 0.9);
    if (similar) {
      // Try LLM conflict resolution if available (from Mem0 pattern)
      try {
        const { getRemoteLLM } = await import("./index.js").then(() => import("../remote-config.js"));
        const remote = getRemoteLLM();
        if (remote) {
          const existingMem = db.prepare(`SELECT text FROM memories WHERE id = ?`).get(similar.id) as { text: string } | null;
          if (existingMem) {
            const prompt = `Compare these two memory statements and decide the action:\n\nExisting: "${existingMem.text}"\nNew: "${text}"\n\nRespond with exactly one word: ADD (new fact), UPDATE (merge into existing), DELETE (contradicts existing), or NONE (duplicate).`;
            const decision = await remote.chatComplete(prompt);
            const action = decision?.trim().toUpperCase();
            if (action === "UPDATE") {
              const merged = await remote.chatComplete(`Merge these into one concise statement:\n1. "${existingMem.text}"\n2. "${text}"\n\nRespond with only the merged statement.`);
              if (merged && merged.length > 10) {
                db.prepare(`UPDATE memories SET text = ?, content_hash = ?, last_accessed = ? WHERE id = ?`).run(merged.trim(), contentHash(merged.trim()), now, similar.id);
                db.prepare(`INSERT INTO memory_history (memory_id, action, old_value, new_value, timestamp) VALUES (?, 'UPDATE', ?, ?, ?)`).run(similar.id, existingMem.text, merged.trim(), now);
                return { id: similar.id, status: "duplicate", duplicate_id: similar.id };
              }
            } else if (action === "DELETE") {
              db.prepare(`INSERT INTO memory_history (memory_id, action, old_value, timestamp) VALUES (?, 'DELETE', ?, ?)`).run(similar.id, existingMem.text, now);
              db.prepare(`DELETE FROM memories WHERE id = ?`).run(similar.id);
              try { db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(similar.id); } catch {}
              // Fall through to insert the new memory
            } else if (action === "ADD") {
              // Fall through to insert as new memory
            } else {
              // NONE or unrecognized — treat as duplicate
              db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`).run(now, similar.id);
              return { id: similar.id, status: "duplicate", duplicate_id: similar.id };
            }
          }
        } else {
          // No LLM — fall back to cosine threshold
          db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`).run(now, similar.id);
          return { id: similar.id, status: "duplicate", duplicate_id: similar.id };
        }
      } catch {
        // LLM conflict resolution failed — fall back to cosine threshold
        db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`).run(now, similar.id);
        return { id: similar.id, status: "duplicate", duplicate_id: similar.id };
      }
    }
  }

  // Insert memory
  const id = randomUUID();
  db.prepare(`
    INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 'peripheral', 0, ?, ?)
  `).run(id, text, hash, category, scope, importance, now, options.metadata ? JSON.stringify(options.metadata) : null);

  // Insert vector
  if (embedding) {
    try {
      ensureMemoriesVecTable(db, embedding.length);
      db.prepare(`INSERT INTO memories_vec (scope, id, embedding) VALUES (?, ?, ?)`).run(scope, id, new Float32Array(embedding));
    } catch (err) {
      process.stderr.write(`Memory vector insert failed (memory still stored): ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // Changelog
  db.prepare(`INSERT INTO memory_history (memory_id, action, new_value, timestamp) VALUES (?, 'ADD', ?, ?)`).run(id, text, now);

  return { id, status: "created" };
}

/**
 * Batch insert memories with shared embedding round-trip.
 *
 * Optimization for ingest pipelines (eval, OpenClaw bulk import) that
 * need to store many memories without paying per-memory LLM round-trips.
 *
 * Skips cosine dedup (per-item LLM conflict resolution) for speed —
 * still does hash dedup. For richer dedup use single memoryStore() in a
 * loop. Most bulk ingests don't need cosine dedup because the source is
 * already deduplicated (raw conversation turns, extracted facts, etc.).
 *
 * Returns one result per input in the same order. created/duplicate status
 * is reported per-item.
 */
export async function memoryStoreBatch(
  db: Database,
  items: MemoryStoreOptions[]
): Promise<{ id: string; status: "created" | "duplicate" }[]> {
  if (items.length === 0) return [];
  const now = Date.now();
  const results: { id: string; status: "created" | "duplicate" }[] = new Array(items.length);

  // Phase 1: hash dedup (single round-trip)
  const hashes = items.map(it => contentHash(it.text.trim()));
  const placeholders = hashes.map(() => "?").join(",");
  const existingRows = db.prepare(
    `SELECT id, content_hash FROM memories WHERE content_hash IN (${placeholders})`
  ).all(...hashes) as { id: string; content_hash: string }[];
  const existingByHash = new Map(existingRows.map(r => [r.content_hash, r.id]));

  // Phase 2: collect texts that need embedding
  const toEmbed: { idx: number; text: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const text = items[i]!.text.trim();
    if (!text) {
      results[i] = { id: "", status: "duplicate" };
      continue;
    }
    const existingId = existingByHash.get(hashes[i]!);
    if (existingId) {
      results[i] = { id: existingId, status: "duplicate" };
      continue;
    }
    toEmbed.push({ idx: i, text });
  }

  // Phase 3: batched embedding (one provider call when supported)
  const embeddings: (number[] | null)[] = toEmbed.length > 0
    ? await embedTextBatch(toEmbed.map(t => t.text))
    : [];

  // Phase 4: insert in a single SQLite transaction
  const insertMem = db.prepare(`
    INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 'peripheral', 0, ?, ?)
  `);
  const insertVecRef: { stmt: ReturnType<typeof db.prepare> | null } = { stmt: null };
  const insertHistory = db.prepare(`INSERT INTO memory_history (memory_id, action, new_value, timestamp) VALUES (?, 'ADD', ?, ?)`);
  const touch = db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`);

  const txn = db.transaction(() => {
    for (let j = 0; j < toEmbed.length; j++) {
      const { idx, text } = toEmbed[j]!;
      const opts = items[idx]!;
      const id = randomUUID();
      const category = opts.category || classifyMemory(text);
      const scope = opts.scope || "global";
      const importance = Math.max(0, Math.min(1, opts.importance ?? 0.5));
      insertMem.run(id, text, hashes[idx]!, category, scope, importance, now, opts.metadata ? JSON.stringify(opts.metadata) : null);
      insertHistory.run(id, text, now);

      const emb = embeddings[j];
      if (emb) {
        try {
          if (!insertVecRef.stmt) {
            ensureMemoriesVecTable(db, emb.length);
            insertVecRef.stmt = db.prepare(`INSERT INTO memories_vec (scope, id, embedding) VALUES (?, ?, ?)`);
          }
          insertVecRef.stmt.run(scope, id, new Float32Array(emb));
        } catch { /* dimension mismatch / table failure — memory still stored */ }
      }

      results[idx] = { id, status: "created" };
    }
    // Touch access counts for hash duplicates
    for (let i = 0; i < items.length; i++) {
      if (results[i] && results[i]!.status === "duplicate" && results[i]!.id) {
        touch.run(now, results[i]!.id);
      }
    }
  });
  txn();

  return results;
}

/**
 * Adaptive vector-similarity acceptance gate.
 *
 * Replaces the legacy fixed 0.3 cosine cutoff. Two-pass:
 *   1. Compute a floor as max(absFloor, top1 × relRatio)
 *   2. Accept results in rank order. Anything ≥ floor passes; below the
 *      floor we still keep up to `minKeep` results so a low-signal query
 *      doesn't end up with an empty vector pool (BM25 then fills the gap).
 *
 * QMD_VEC_MIN_SIM:
 *   unset / "adaptive" → adaptive (default)
 *   "0"               → take everything (most permissive)
 *   "<number>"        → legacy fixed-threshold behaviour
 *
 * Exported for unit testing — the runtime path inlines the logic above.
 */
export function pickVectorMatches<T extends { similarity: number }>(
  results: T[],
  options: {
    absFloor?: number;
    relRatio?: number;
    minKeep?: number;
    fixedFloorEnv?: string;
  } = {}
): T[] {
  const ABS_FLOOR = options.absFloor ?? 0.05;
  const REL_RATIO = options.relRatio ?? 0.5;
  const MIN_KEEP = options.minKeep ?? 5;
  const envValue = options.fixedFloorEnv ?? process.env.QMD_VEC_MIN_SIM;

  const sorted = [...results].sort((a, b) => b.similarity - a.similarity);

  const fixedFloor = envValue && envValue !== "adaptive" && !isNaN(Number(envValue))
    ? Number(envValue)
    : null;
  const top1 = sorted[0]?.similarity ?? 0;
  const adaptiveFloor = Math.max(ABS_FLOOR, top1 * REL_RATIO);
  const floor = fixedFloor !== null ? fixedFloor : adaptiveFloor;

  const out: T[] = [];
  for (const r of sorted) {
    const passes = r.similarity >= floor;
    const keepAnyway = out.length < MIN_KEEP;
    if (!passes && !keepAnyway) continue;
    out.push(r);
  }
  return out;
}

/**
 * Extract capitalized multi-word entities from the query as a rough
 * proper-noun filter. Used to decide whether the KG-in-recall injection
 * should fire. Very conservative — matches "Caroline", "London",
 * "Samsung Galaxy S22"; misses lowercase entities and single-letter
 * abbreviations. Zero-dependency, no NER runtime.
 */
function extractQueryEntities(query: string): string[] {
  // Match 1-3 consecutive capitalized words. Skip sentence-initial words
  // that are stopwords to reduce false positives ("Which did I first…").
  const STOPWORDS = new Set(["Which", "Who", "What", "When", "Where", "How", "Why", "Did", "Does", "Is", "Are", "Was", "Were", "The", "This", "That", "These", "Those", "Yes", "No"]);
  const matches = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g) || [];
  return matches
    .map(m => m.trim())
    .filter(m => {
      const first = m.split(/\s+/)[0]!;
      return !STOPWORDS.has(first) && m.length >= 3;
    })
    // Dedupe while preserving order
    .filter((m, i, a) => a.indexOf(m) === i);
}

/**
 * Query the knowledge graph for triples about the given entities, scoped
 * to the caller's memory scope. Each triple is rendered as a short
 * memory-style sentence. Capped at maxFacts total across all entities
 * (default 5) to avoid flooding the top-K.
 */
function queryKGForEntities(
  db: Database,
  entities: string[],
  scope: string | undefined,
  maxFacts: number = 5
): Array<{ id: string; text: string }> {
  const facts: Array<{ id: string; text: string }> = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    if (facts.length >= maxFacts) break;
    let triples: KnowledgeEntry[] = [];
    try {
      triples = knowledgeQuery(db, { subject: entity, scope, limit: 10 });
    } catch {
      continue;
    }
    for (const t of triples) {
      if (facts.length >= maxFacts) break;
      const text = `${t.subject} ${t.predicate} ${t.object}`;
      if (seen.has(text)) continue;
      seen.add(text);
      facts.push({ id: `kg:${t.id}`, text });
    }
  }
  return facts;
}

/**
 * Extract a dialog/session key from a memory's metadata JSON.
 * Prefers dialog-level ID ("D1:3") which is strictly more specific than
 * the session-level ID ("D1"). Returns null for memories with no metadata.
 */
function memoryDialogKey(m: { metadata?: string | null }): string | null {
  if (!m.metadata) return null;
  try {
    const meta = JSON.parse(m.metadata) as {
      source_dialog_id?: string;
      source_session_id?: string;
    };
    return meta.source_dialog_id || meta.source_session_id || null;
  } catch {
    return null;
  }
}

/**
 * Dialog-aware MMR-lite re-selection. Preserves rank-order priority but
 * prefers picking memories from dialogs/sessions we haven't seen yet.
 * When all remaining candidates share already-covered dialogs, falls
 * back to score order for the rest.
 *
 * Complexity: O(limit × sorted.length) worst case — fine for typical
 * limit=50 / sorted.length≤150.
 */
function applyDialogDiversity<T extends { metadata?: string | null }>(
  sorted: T[],
  limit: number
): T[] {
  const selected: T[] = [];
  const remaining = [...sorted];
  const seen = new Set<string>();

  while (selected.length < limit && remaining.length > 0) {
    // First try: pick the top candidate whose dialog key is unseen.
    let pickIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const key = memoryDialogKey(remaining[i]!);
      if (!key || !seen.has(key)) {
        pickIdx = i;
        break;
      }
    }
    // Everything left is from already-covered dialogs → take top by score.
    if (pickIdx === -1) pickIdx = 0;

    const [picked] = remaining.splice(pickIdx, 1);
    if (!picked) break;
    selected.push(picked);
    const key = memoryDialogKey(picked);
    if (key) seen.add(key);
  }

  return selected;
}

export async function memoryRecall(
  db: Database,
  options: MemoryRecallOptions
): Promise<MemoryRecallResult[]> {
  const query = options.query.trim();
  if (!query) return [];
  const limit = options.limit || 10;
  const scope = options.scope;
  const category = options.category;
  // Tier filter (roadmap cat 1): a normalized set of tiers to accept.
  // Empty set = no filter (all tiers eligible).
  const tierFilter: Set<string> | null = options.tier
    ? new Set(Array.isArray(options.tier) ? options.tier : [options.tier])
    : null;

  // Prepared statements — reused across FTS and vec lookups (avoids recompile)
  const getByRowid = db.prepare(`SELECT * FROM memories WHERE rowid = ?`);
  const getById = db.prepare(`SELECT * FROM memories WHERE id = ?`);

  const results = new Map<string, MemoryRecallResult & { _access_count: number; _tier: string }>();

  // Raw mode disables every post-RRF boost so we can fairly compare against
  // bare-vector baselines like MemPalace's 96.6% LongMemEval recipe.
  // BM25 + vector are still combined; everything else (decay, temporal,
  // keyword boost, quoted phrase, query expansion, rerank) is skipped.
  const RAW = process.env.QMD_RECALL_RAW === "on";

  const addResult = (mem: Memory, score: number) => {
    if (scope && mem.scope !== scope && mem.scope !== "global") return;
    if (category && mem.category !== category) return;
    if (tierFilter && !tierFilter.has(mem.tier)) return;
    const existing = results.get(mem.id);
    if (existing) {
      existing.score += score;
    } else {
      results.set(mem.id, {
        id: mem.id, text: mem.text, category: mem.category, scope: mem.scope,
        importance: mem.importance, score, created_at: mem.created_at,
        _access_count: mem.access_count, _tier: mem.tier,
        metadata: mem.metadata,
      });
    }
  };

  // Zero-LLM multi-query expansion (gated by QMD_MEMORY_EXPAND).
  //
  // entities — builds sub-queries from proper-noun entities + keywords.
  //   Works on workloads with rich named-entity density (e.g. knowledge
  //   bases, meeting notes with people/projects). Weak on LongMemEval
  //   because most questions reference lowercase concepts.
  //
  // keywords — splits extracted keywords into N groups and fans out one
  //   sub-query per group. Targets multi-hop retrieval where the answer
  //   spans several supporting facts, each matched by a different keyword
  //   cluster. No proper-noun dependency.
  //
  // Q0 (original) always included — worst case degrades to baseline +
  // some noise instead of replacing signal.
  const EXPAND_MODE = process.env.QMD_MEMORY_EXPAND;
  const subQueries: string[] = [query];
  if (EXPAND_MODE === "entities") {
    const expandEntities = extractQueryEntities(query);
    const expandKeywords = extractKeywords(query).slice(0, 6).join(" ");
    for (const e of expandEntities.slice(0, 2)) {
      const sub = expandKeywords ? `${expandKeywords} ${e}` : e;
      if (sub !== query && !subQueries.includes(sub)) subQueries.push(sub);
    }
  } else if (EXPAND_MODE === "keywords") {
    // Split the top keywords into N groups and build a sub-query per group.
    // Group size 2 → 3 sub-queries of 2 keywords each for a 6-keyword query.
    // Cap at 2 sub-queries (plus Q0 = 3 total parallel vec calls) to keep
    // the latency budget reasonable.
    const expandKeywords = extractKeywords(query);
    const groupSize = 2;
    const maxGroups = 2;
    for (let i = 0; i < Math.min(maxGroups, Math.floor(expandKeywords.length / groupSize)); i++) {
      const group = expandKeywords.slice(i * groupSize, (i + 1) * groupSize);
      if (group.length === 0) break;
      const sub = group.join(" ");
      if (sub !== query && !subQueries.includes(sub)) subQueries.push(sub);
    }
  }

  // 1+2. FTS and embedding(s) run in parallel (embedding is the slow part)
  const embeddingsPromise = Promise.all(subQueries.map(q => embedQuery(q)));

  // FTS search (synchronous, runs while embedding request is in flight)
  try {
    // Reuse module-level STOP_WORDS (single source of truth)
    const terms = query
      .replace(/[^\p{L}\p{N}\s'_-]/gu, '')
      .split(/\s+/)
      .map(t => t.toLowerCase().replace(/[^\p{L}\p{N}'_]/gu, ''))
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
    if (terms.length === 0) throw new Error("no terms");

    // Use OR for broad recall, FTS5 ranks by relevance (more term matches = higher rank)
    const safeFtsQuery = terms.map(t => `"${t}"*`).join(' OR ');
    const ftsResults = db.prepare(
      `SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(safeFtsQuery, limit * 3) as { rowid: number; rank: number }[];

    for (const r of ftsResults) {
      const mem = getByRowid.get(r.rowid) as Memory | null;
      if (mem) addResult(mem, Math.abs(r.rank));
    }

    // Strong signal detection (from store/search.ts hybridQuery pattern):
    // If top FTS result is high-confidence with clear gap, skip query expansion
    const STRONG_MIN = 0.85;
    const STRONG_GAP = 0.15;
    const topScore = ftsResults[0] ? Math.abs(ftsResults[0].rank) : 0;
    const secondScore = ftsResults[1] ? Math.abs(ftsResults[1].rank) : 0;
    const maxPossible = ftsResults.length > 0 ? Math.max(...ftsResults.map(r => Math.abs(r.rank))) : 1;
    const normalizedTop = topScore / (maxPossible || 1);
    const normalizedGap = (topScore - secondScore) / (maxPossible || 1);
    const hasStrongSignal = normalizedTop >= STRONG_MIN && normalizedGap >= STRONG_GAP;

    // Query expansion only when no strong FTS signal (saves API call + reduces noise)
    // Skipped entirely in RAW mode.
    if (!RAW && !hasStrongSignal && options.rerank !== false) {
      try {
        const remoteConfig = getRemoteConfig();
        if (remoteConfig?.queryExpansion) {
          const remote = getRemoteLLM()!;
          const expanded = await remote.expandQuery(query, { includeLexical: true });
          const expandedTerms = expanded
            .filter(r => r.type === "lex" && r.text !== query)
            .map(r => r.text);

          for (const eq of expandedTerms) {
            const eqTerms = eq.replace(/[^\p{L}\p{N}\s'_-]/gu, '').split(/\s+/)
              .map(t => t.toLowerCase().replace(/[^\p{L}\p{N}'_]/gu, ''))
              .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
            if (eqTerms.length === 0) continue;
            const eqFts = eqTerms.map(t => `"${t}"*`).join(' OR ');
            try {
              const eqResults = db.prepare(
                `SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`
              ).all(eqFts, limit) as { rowid: number; rank: number }[];
              for (const r of eqResults) {
                const mem = getByRowid.get(r.rowid) as Memory | null;
                if (mem) addResult(mem, Math.abs(r.rank) * 0.5);
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* expansion optional */ }
    }
  } catch {
    // FTS may fail on complex queries
  }

  // Detect partition support on first recall against this DB. The
  // module-level _memoriesVecHasPartition flag may be unset if no
  // ingest has run in this process yet (memoryRecall doesn't call
  // ensureMemoriesVecTable directly because it needs the dimension).
  if (!_memoriesVecHasPartition) {
    try {
      const t = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'`
      ).get() as { sql: string } | null;
      if (t && /partition\s+key/i.test(t.sql)) {
        _memoriesVecHasPartition = true;
      }
    } catch { /* table may not exist yet */ }
  }

  // Vector search (await the embedding(s) that started in parallel with FTS)
  const queryEmbeddings = await embeddingsPromise;
  if (queryEmbeddings.some(e => e)) {
    try {
      // ── Scope-partitioned vec query ────────────────────────────────
      //
      // memories_vec ships with `scope TEXT PARTITION KEY` so sqlite-vec
      // walks only the current scope's slice of the index. Two paths:
      //   - scoped: WHERE scope = ? AND embedding MATCH ?  (preferred)
      //   - global: WHERE embedding MATCH ?               (fallback)
      // The K-multiplier override remains for the global path and for
      // edge cases where partition isolation filters too aggressively.
      const kMultiplier = Number(process.env.QMD_VEC_K_MULTIPLIER ?? "3");
      const vecK = Math.max(limit, limit * kMultiplier);

      const runVecKnn = (emb: number[]): Array<{ id: string; distance: number }> => {
        if (_memoriesVecHasPartition && scope) {
          try {
            const scoped = db.prepare(
              `SELECT id, distance FROM memories_vec
               WHERE scope = ? AND embedding MATCH ? AND k = ?`
            ).all(scope, new Float32Array(emb), vecK) as Array<{ id: string; distance: number }>;
            const globalResults = db.prepare(
              `SELECT id, distance FROM memories_vec
               WHERE scope = ? AND embedding MATCH ? AND k = ?`
            ).all("global", new Float32Array(emb), Math.min(vecK, limit)) as Array<{ id: string; distance: number }>;
            return scoped.concat(globalResults);
          } catch {
            return db.prepare(
              `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?`
            ).all(new Float32Array(emb), vecK * 20) as Array<{ id: string; distance: number }>;
          }
        }
        return db.prepare(
          `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?`
        ).all(new Float32Array(emb), vecK * 20) as Array<{ id: string; distance: number }>;
      };

      // Merge vec hits across sub-queries by id, keeping max similarity.
      // For single-query (non-expand) path, this is identical to the old
      // behavior — one pass, one hit per id. For expand path, an id seen
      // in multiple sub-queries keeps its strongest cosine.
      const mergedHits = new Map<string, number>(); // id → max similarity
      for (const qEmb of queryEmbeddings) {
        if (!qEmb) continue;
        for (const r of runVecKnn(qEmb)) {
          const sim = 1 - r.distance;
          const prev = mergedHits.get(r.id);
          if (prev === undefined || sim > prev) mergedHits.set(r.id, sim);
        }
      }

      // ── Scope-normalized scoring (gated by QMD_MEMORY_SCOPE_NORM=rank) ──
      //
      // Rank-normalize similarities within each scope so cross-scope
      // cosine magnitude drift doesn't wash out the right answer. Noop
      // when the candidate pool contains a single scope (which is the
      // case on LongMemEval where scope = question_id). Targets multi-
      // project qmd workloads where one recall query spans several
      // partitioned scopes via the "global" union path.
      let withSim: Array<{ id: string; similarity: number }>;
      const SCOPE_NORM = process.env.QMD_MEMORY_SCOPE_NORM === "rank";
      if (SCOPE_NORM && mergedHits.size > 1) {
        // Fetch scope per id via a single IN() query; avoid N round-trips.
        const ids = Array.from(mergedHits.keys());
        const placeholders = ids.map(() => "?").join(",");
        const scopeRows = db.prepare(
          `SELECT id, scope FROM memories WHERE id IN (${placeholders})`
        ).all(...ids) as Array<{ id: string; scope: string }>;
        const idToScope = new Map<string, string>();
        for (const row of scopeRows) idToScope.set(row.id, row.scope);

        // Group by scope, sort within each by descending similarity,
        // rewrite similarity = 1 / (RRF_K + rank_in_scope).
        const RRF_K = 60;
        const byScope = new Map<string, Array<{ id: string; similarity: number }>>();
        for (const [id, similarity] of mergedHits) {
          const s = idToScope.get(id) ?? "__unknown__";
          const arr = byScope.get(s) ?? [];
          arr.push({ id, similarity });
          byScope.set(s, arr);
        }
        if (byScope.size <= 1) {
          // Single scope → noop, keep original cosines.
          withSim = Array.from(mergedHits, ([id, similarity]) => ({ id, similarity }));
        } else {
          withSim = [];
          for (const arr of byScope.values()) {
            arr.sort((a, b) => b.similarity - a.similarity);
            for (let rank = 0; rank < arr.length; rank++) {
              withSim.push({ id: arr[rank]!.id, similarity: 1 / (RRF_K + rank) });
            }
          }
        }
      } else {
        withSim = Array.from(mergedHits, ([id, similarity]) => ({ id, similarity }));
      }

      // Adaptive vector acceptance — pickVectorMatches handles the floor.
      // Session-diversity MMR (gated by QMD_MEMORY_MMR=session) penalizes
      // repeat picks from the same source session. Directly attacks the
      // LongMemEval multi-session category where the right answer spans
      // multiple session chunks.
      const mmrMode = process.env.QMD_MEMORY_MMR;
      const accepted = pickVectorMatches(withSim);
      if (mmrMode === "session") {
        const seenSessions = new Set<string>();
        const diversified: Array<{ id: string; similarity: number }> = [];
        const leftovers: Array<{ id: string; similarity: number }> = [];
        // Pre-fetch memories in one batch so we can read metadata.source_session_id.
        const ids = accepted.map(r => r.id);
        const memMap = new Map<string, Memory>();
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT * FROM memories WHERE id IN (${placeholders})`
          ).all(...ids) as Memory[];
          for (const m of rows) memMap.set(m.id, m);
        }
        for (const r of accepted) {
          const mem = memMap.get(r.id);
          const meta = mem?.metadata as Record<string, unknown> | undefined;
          const sessionId = typeof meta?.source_session_id === "string"
            ? (meta.source_session_id as string)
            : null;
          if (sessionId && seenSessions.has(sessionId)) {
            leftovers.push(r);
          } else {
            if (sessionId) seenSessions.add(sessionId);
            diversified.push(r);
          }
        }
        // Append leftovers at the end so we never shrink the result set.
        for (const r of leftovers) diversified.push(r);
        for (const r of diversified) {
          const mem = memMap.get(r.id);
          if (mem) addResult(mem, r.similarity);
        }
      } else {
        for (const r of accepted) {
          const mem = getById.get(r.id) as Memory | null;
          if (mem) addResult(mem, r.similarity);
        }
      }
    } catch {
      // memories_vec may not exist
    }
  }

  // 3-4. Post-RRF score adjustments — all skipped in RAW mode for fair
  // baseline comparison.
  if (!RAW) {
    // 3. Keyword boost (MemPalace: multiplicative, not additive)
    // fused = base_score × (1 + 0.4 × keyword_overlap_ratio)
    const keywords = extractKeywords(query);
    for (const result of results.values()) {
      const textLower = result.text.toLowerCase();
      let hits = 0;
      for (const kw of keywords) {
        if (textLower.includes(kw)) hits++;
      }
      if (keywords.length > 0) {
        result.score *= 1 + 0.4 * (hits / keywords.length);
      }
    }

    // 3b. Quoted phrase boost (MemPalace v4: 60% boost for exact quoted phrases)
    const quotedPhrases = query.match(/"([^"]+)"/g)?.map(p => p.slice(1, -1).toLowerCase()) || [];
    for (const phrase of quotedPhrases) {
      for (const result of results.values()) {
        if (result.text.toLowerCase().includes(phrase)) {
          result.score *= 1.6;
        }
      }
    }

    // 4. Apply decay weighting — uses data already fetched (no extra query)
    for (const result of results.values()) {
      const decay = getDecayScore(result.created_at, result._access_count, result.importance, result._tier);
      result.score *= decay;
    }

    // 4b. Temporal boost — memories near a time reference in the query score higher
    // From MemPalace HYBRID_MODE.md: up to 40% boost for time-proximate memories
    const timeRef = parseTimeReference(query);
    if (timeRef) {
      const MS_PER_DAY = 86400000;

      // Also inject recent memories by timestamp (temporal queries often don't match FTS/vec)
      const windowMs = timeRef.windowDays * MS_PER_DAY;
      const recentRows = db.prepare(
        `SELECT * FROM memories WHERE created_at > ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
      ).all(timeRef.targetMs - windowMs, timeRef.targetMs + windowMs, limit) as Memory[];
      for (const mem of recentRows) {
        if (scope && mem.scope !== scope) continue;
        if (category && mem.category !== category) continue;
        if (!results.has(mem.id)) {
          addResult(mem, 0.5); // base score for time-matched memories
        }
      }

      for (const result of results.values()) {
        const daysDiff = Math.abs(result.created_at - timeRef.targetMs) / MS_PER_DAY;
        const boost = Math.max(0, 0.40 * (1 - daysDiff / timeRef.windowDays));
        if (boost > 0) result.score *= 1 + boost;
      }
    }
  }

  // 5. Sort by combined score (single pool — dual-pass tested + lost in v15)
  let sorted = [...results.values()].sort((a, b) => b.score - a.score);

  // 5b. Optional: rerank top candidates with LLM/dedicated reranker (skip in RAW)
  if (!RAW && options.rerank !== false && sorted.length > 1) {
    const rerankCandidates = sorted.slice(0, Math.min(sorted.length, limit * 3));
    try {
      const remoteConfig = getRemoteConfig();
      if (remoteConfig?.rerank) {
        const remote = getRemoteLLM()!;
        const docs = rerankCandidates.map(r => ({ file: r.id, text: r.text }));
        const result = await remote.rerank(query, docs, {});
        // Merge rerank scores: blend original score with rerank score
        const rerankMap = new Map(result.results.map(r => [r.file, r.score]));
        for (const r of rerankCandidates) {
          const rerankScore = rerankMap.get(r.id);
          if (rerankScore !== undefined) {
            // Blend: 40% original + 60% rerank (reranker is more precise)
            r.score = 0.4 * r.score + 0.6 * rerankScore;
          }
        }
        sorted = rerankCandidates.sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      // Rerank failed — fall back to original ranking
      process.stderr.write(`Memory rerank failed: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // 5b2. Smart KG-in-recall (v16, roadmap cat 10 + cat 2). The knowledge
  // graph is populated by extractAndStore but wasn't being queried during
  // recall — v8 tried a blunt injection and had to roll back because
  // generic entries flooded the top results and hurt single-hop F1.
  //
  // This pass is gated by three conditions to avoid the v8 failure mode:
  //   1. Opt-in: QMD_RECALL_KG=on (default off, baseline unchanged)
  //   2. Query must contain at least one proper-noun entity (Caroline,
  //      Samsung Galaxy S22, …). Lowercase/wh-questions are skipped.
  //   3. Fires only when the current top score is weak (< 0.3) — strong
  //      FTS/vec hits are never displaced.
  // KG facts are capped at 5 total and inserted with moderate score (0.25)
  // so they rank below any real strong hits and only surface when the
  // main pipeline came up short. Also skipped in RAW mode.
  if (!RAW && process.env.QMD_RECALL_KG === "on") {
    const entities = extractQueryEntities(query);
    const topScore = sorted[0]?.score ?? 0;
    if (entities.length > 0 && entities.length <= 3 && topScore < 0.3) {
      const kgFacts = queryKGForEntities(db, entities, scope, 5);
      let kgAdded = 0;
      for (const fact of kgFacts) {
        if (results.has(fact.id)) continue;
        const entry = {
          id: fact.id,
          text: fact.text,
          category: "fact",
          scope: scope || "global",
          importance: 0.6,
          score: 0.25,
          created_at: Date.now(),
          _access_count: 0,
          _tier: "peripheral",
          metadata: null,
        };
        results.set(fact.id, entry);
        sorted.push(entry);
        kgAdded++;
      }
      if (kgAdded > 0) {
        sorted.sort((a, b) => b.score - a.score);
      }
    }
  }

  // 5c. Dialog-aware diversity (v16). Addresses the DR@K vs SR@K gap:
  // on multi-evidence queries, a plain score sort often piles up several
  // memories from the same source dialog, leaving other evidence dialogs
  // uncovered in the top-K. Greedy MMR-lite reshuffles the top-limit to
  // prefer unseen source_dialog_id / source_session_id first, falling
  // back to score order when all remaining candidates come from already-
  // covered dialogs. Opt-in via QMD_RECALL_DIVERSIFY=on (default off so
  // the baseline is unchanged).
  if (!RAW && process.env.QMD_RECALL_DIVERSIFY === "on" && sorted.length > 2) {
    sorted = applyDialogDiversity(sorted, limit);
  } else {
    sorted = sorted.slice(0, limit);
  }

  // Touch access counts for recalled memories (batched in transaction for performance)
  const now = Date.now();
  const touchStmt = db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`);
  db.exec("BEGIN");
  try {
    for (const r of sorted) { touchStmt.run(now, r.id); }
    db.exec("COMMIT");
  } catch { db.exec("ROLLBACK"); }

  return sorted;
}

/**
 * Post-retrieval reflect synthesis (roadmap cat 11 — Hindsight pattern).
 *
 * Takes a question and a list of retrieved memories, makes ONE LLM call
 * that identifies which facts in the memories are relevant to the
 * question, and returns them as a compressed numbered list. The idea:
 * instead of dumping 50 memories into the answer prompt and letting the
 * answer model sift, pre-filter with a dedicated extract pass so the
 * answer call sees only the signal.
 *
 * Known to help on multi-session questions where the relevant facts
 * are scattered across many top-K hits — exactly the LME multi-session
 * F1 bottleneck flagged in the v15.1 benchmark.
 *
 * Returns null if:
 *   - no remote LLM is configured (caller falls back to raw memories)
 *   - the LLM call fails
 *   - the response can't be parsed
 *
 * Cost: one extra chatComplete call per question. Cache-friendly if
 * QMD_LLM_CACHE_PATH is set.
 */
export async function memoryReflect(
  question: string,
  memories: Array<{ text: string }>,
  options: { maxFacts?: number } = {}
): Promise<string | null> {
  if (memories.length === 0) return null;

  const remote = getRemoteLLM();
  if (!remote) return null;

  const maxFacts = options.maxFacts ?? 5;
  const context = memories.map((m, i) => `[${i + 1}] ${m.text}`).join("\n");

  const prompt = `You are a fact-extraction assistant. Below is a question and a set of candidate memories. Extract at most ${maxFacts} facts from the memories that are directly relevant to answering the question. Output only the facts, one per line, numbered. Do not explain. Do not invent facts not in the memories. If nothing is relevant, output the single line: NONE.

Question: ${question}

Memories:
${context}

Relevant facts:`;

  try {
    const reply = await remote.chatComplete(prompt);
    if (!reply) return null;
    const trimmed = reply.trim();
    if (!trimmed || trimmed === "NONE") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Periodic reflection pass (roadmap cat 18 — Generative Agents pattern).
 *
 * Walks the most recent N memories within the given scope, asks the
 * remote LLM to identify 3-5 high-level themes / decisions / patterns
 * across them, and stores each as a new memory with category=reflection.
 *
 * Intended for cron-like calls (session_end, daily tick, dream
 * consolidation). Differs from memoryReflect (which is question-driven)
 * in that this runs unprompted over the raw memory stream to generate
 * long-term context. Stored reflections show up in future recall via
 * the normal FTS + vector paths.
 *
 * No-ops when:
 *   - fewer than minMemories candidates exist (default 5)
 *   - no remote LLM is configured
 *   - the LLM call fails or returns unparseable output
 */
export async function runReflectionPass(
  db: Database,
  options: {
    scope?: string;
    /** Look at memories created within the last N days. Default 7. */
    windowDays?: number;
    /** Minimum memory count to trigger a reflection pass. Default 5. */
    minMemories?: number;
    /** Max memories to include in the prompt. Default 30. */
    maxMemories?: number;
    /** Max reflections to generate. Default 5. */
    maxReflections?: number;
  } = {}
): Promise<{ reflections: number; skipped: boolean; reason?: string }> {
  const scope = options.scope;
  const windowDays = options.windowDays ?? 7;
  const minMemories = options.minMemories ?? 5;
  const maxMemories = options.maxMemories ?? 30;
  const maxReflections = options.maxReflections ?? 5;

  const remote = getRemoteLLM();
  if (!remote) return { reflections: 0, skipped: true, reason: "no remote LLM" };

  const since = Date.now() - windowDays * 86400000;
  const where = scope
    ? `WHERE created_at >= ? AND (scope = ? OR scope = 'global') AND category != 'reflection'`
    : `WHERE created_at >= ? AND category != 'reflection'`;
  const params: unknown[] = scope ? [since, scope] : [since];
  const rows = db.prepare(`
    SELECT id, text, category, created_at FROM memories
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, maxMemories) as Array<{ id: string; text: string; category: string; created_at: number }>;

  if (rows.length < minMemories) {
    return { reflections: 0, skipped: true, reason: `only ${rows.length} candidates (need ${minMemories})` };
  }

  const memoryBlock = rows
    .map((m, i) => `[${i + 1}] ${m.text}`)
    .join("\n");

  const prompt = `You are summarising recent agent memories for long-term recall. Below are the last ${rows.length} memories from the session. Produce at most ${maxReflections} high-level reflections that capture recurring themes, decisions, preferences, or open questions across them. Each reflection must be:
  - a standalone fact or observation (one sentence)
  - grounded in the memories (do not invent)
  - numbered, one per line
  - without explanation or preamble

If no reflections are warranted, output the single line: NONE.

Memories:
${memoryBlock}

Reflections:`;

  let reply: string | null = null;
  try {
    reply = await remote.chatComplete(prompt);
  } catch {
    return { reflections: 0, skipped: true, reason: "LLM call failed" };
  }
  if (!reply) return { reflections: 0, skipped: true, reason: "empty LLM reply" };
  const trimmed = reply.trim();
  if (!trimmed || trimmed === "NONE") {
    return { reflections: 0, skipped: false };
  }

  // Parse numbered lines into individual reflections.
  const reflections: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+[.)\-]?\s*(.+?)\s*$/);
    if (!match) continue;
    const text = match[1]!.trim();
    if (text.length >= 5) reflections.push(text);
    if (reflections.length >= maxReflections) break;
  }

  if (reflections.length === 0) {
    return { reflections: 0, skipped: false };
  }

  // Store each as a reflection memory. Reuses memoryStoreBatch for dedup.
  const items = reflections.map(text => ({
    text,
    scope: scope || "global",
    importance: 0.75,
  }));
  const stored = await memoryStoreBatch(db, items);
  const created = stored.filter(r => r.status === "created").length;
  return { reflections: created, skipped: false };
}

/**
 * Push Pack — proactive "hot state" bundle for session priming (roadmap cat 16).
 *
 * Tinkerclaw Total Recall's pattern: before the agent does anything,
 * push a small pack of Task State + hot tail + time markers into the
 * context so relevant long-term memory is immediately present without
 * needing an explicit recall call. This is the Push side of the
 * push/pull symmetry — memoryRecall is the pull side.
 *
 * Zero-LLM, deterministic SQL — cheap to call from session_start /
 * before_prompt_build hooks. Returns an ordered list that callers can
 * format into a prompt prefix or system message.
 *
 * Selection logic:
 *   - Core-tier memories (promoted — the long-term backbone)
 *   - High-importance working-tier memories in the last windowDays
 *   - Most recently accessed memories (hot tail)
 * Deduped by id, truncated to maxEntries (default 10).
 */
export function memoryPushPack(
  db: Database,
  options: {
    scope?: string;
    /** Window in days for hot-tail selection. Default 14. */
    windowDays?: number;
    /** Max memories in the pack. Default 10. */
    maxEntries?: number;
    /** Importance floor for working-tier pulls. Default 0.7. */
    minImportance?: number;
  } = {}
): Array<{ id: string; text: string; tier: string; importance: number; reason: string }> {
  const scope = options.scope;
  const windowDays = options.windowDays ?? 14;
  const maxEntries = options.maxEntries ?? 10;
  const minImp = options.minImportance ?? 0.7;
  const since = Date.now() - windowDays * 86400000;

  const scopeClause = scope ? `AND (scope = ? OR scope = 'global')` : "";
  const scopeParams = scope ? [scope] : [];

  // Core tier — always included
  const coreRows = db.prepare(`
    SELECT id, text, tier, importance FROM memories
    WHERE tier = 'core' ${scopeClause}
    ORDER BY importance DESC, last_accessed DESC NULLS LAST
    LIMIT ?
  `).all(...scopeParams, maxEntries) as Array<{ id: string; text: string; tier: string; importance: number }>;

  // High-importance recent — working / peripheral but important and fresh
  const importantRows = db.prepare(`
    SELECT id, text, tier, importance FROM memories
    WHERE tier != 'core'
      AND importance >= ?
      AND created_at >= ?
      ${scopeClause}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(minImp, since, ...scopeParams, maxEntries) as Array<{ id: string; text: string; tier: string; importance: number }>;

  // Hot tail — most recently accessed
  const hotRows = db.prepare(`
    SELECT id, text, tier, importance FROM memories
    WHERE last_accessed IS NOT NULL
      AND last_accessed >= ?
      ${scopeClause}
    ORDER BY last_accessed DESC
    LIMIT ?
  `).all(since, ...scopeParams, maxEntries) as Array<{ id: string; text: string; tier: string; importance: number }>;

  const seen = new Set<string>();
  const pack: Array<{ id: string; text: string; tier: string; importance: number; reason: string }> = [];

  const pushReason = (rows: typeof coreRows, reason: string) => {
    for (const r of rows) {
      if (pack.length >= maxEntries) return;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      pack.push({ ...r, reason });
    }
  };

  pushReason(coreRows, "core");
  pushReason(importantRows, "important-recent");
  pushReason(hotRows, "hot-tail");

  return pack;
}

/**
 * Tier-grouped recall (roadmap cat 1 — Tiered / Hierarchical Storage).
 *
 * Runs three parallel recalls scoped to each tier and returns the
 * results as a structured object. Callers that want separate
 * working/core pools (Zep-style subgraph queries, MemGPT recall vs
 * archival) can use this instead of manually filtering a flat recall.
 *
 * Each tier call gets its own limit — default 5 per tier — so the
 * caller receives up to 15 memories total. Scope, category, and rerank
 * options are forwarded to all three calls.
 *
 * This is a behavioural "tiered storage" entry point without a schema
 * rewrite. All memories still live in the `memories` table; the
 * tier-aware API surfaces what was always possible but not exposed.
 */
export async function memoryRecallTiered(
  db: Database,
  options: Omit<MemoryRecallOptions, "tier"> & { perTierLimit?: number }
): Promise<{
  core: MemoryRecallResult[];
  working: MemoryRecallResult[];
  peripheral: MemoryRecallResult[];
}> {
  const perTierLimit = options.perTierLimit ?? 5;
  const base = { ...options, limit: perTierLimit };
  const [core, working, peripheral] = await Promise.all([
    memoryRecall(db, { ...base, tier: "core" }),
    memoryRecall(db, { ...base, tier: "working" }),
    memoryRecall(db, { ...base, tier: "peripheral" }),
  ]);
  return { core, working, peripheral };
}

export function memoryForget(
  db: Database,
  id: string
): { deleted: boolean } {
  const mem = db.prepare(`SELECT text, scope FROM memories WHERE id = ?`).get(id) as { text: string; scope: string } | null;
  if (!mem) return { deleted: false };

  const now = Date.now();
  db.prepare(`INSERT INTO memory_history (memory_id, action, old_value, timestamp) VALUES (?, 'DELETE', ?, ?)`).run(id, mem.text, now);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  try { db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id); } catch {}

  return { deleted: true };
}

export async function memoryUpdate(
  db: Database,
  options: MemoryUpdateOptions
): Promise<{ updated: boolean }> {
  const mem = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(options.id) as Memory | null;
  if (!mem) return { updated: false };

  const now = Date.now();
  const changes: string[] = [];

  if (options.text !== undefined && options.text !== mem.text) {
    const newText = options.text.trim();
    const newHash = contentHash(newText);
    db.prepare(`UPDATE memories SET text = ?, content_hash = ? WHERE id = ?`).run(newText, newHash, options.id);
    db.prepare(`INSERT INTO memory_history (memory_id, action, old_value, new_value, timestamp) VALUES (?, 'UPDATE', ?, ?, ?)`).run(options.id, mem.text, newText, now);

    // Re-embed
    const embedding = await embedText(newText);
    if (embedding) {
      ensureMemoriesVecTable(db, embedding.length);
      try { db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(options.id); } catch {}
      db.prepare(`INSERT INTO memories_vec (scope, id, embedding) VALUES (?, ?, ?)`).run(mem.scope, options.id, new Float32Array(embedding));
    }
    changes.push("text");
  }

  if (options.importance !== undefined) {
    db.prepare(`UPDATE memories SET importance = ? WHERE id = ?`).run(Math.max(0, Math.min(1, options.importance)), options.id);
    changes.push("importance");
  }

  if (options.category !== undefined) {
    db.prepare(`UPDATE memories SET category = ? WHERE id = ?`).run(options.category, options.id);
    changes.push("category");
  }

  if (options.metadata !== undefined) {
    db.prepare(`UPDATE memories SET metadata = ? WHERE id = ?`).run(JSON.stringify(options.metadata), options.id);
    changes.push("metadata");
  }

  return { updated: changes.length > 0 };
}

// =============================================================================
// Memory stats
// =============================================================================

export function memoryStats(db: Database): {
  total: number;
  byTier: Record<string, number>;
  byCategory: Record<string, number>;
  byScope: Record<string, number>;
} {
  const total = (db.prepare(`SELECT COUNT(*) as count FROM memories`).get() as { count: number }).count;
  const tierRows = db.prepare(`SELECT tier, COUNT(*) as count FROM memories GROUP BY tier`).all() as { tier: string; count: number }[];
  const catRows = db.prepare(`SELECT category, COUNT(*) as count FROM memories GROUP BY category`).all() as { category: string; count: number }[];
  const scopeRows = db.prepare(`SELECT scope, COUNT(*) as count FROM memories GROUP BY scope`).all() as { scope: string; count: number }[];

  return {
    total,
    byTier: Object.fromEntries(tierRows.map(r => [r.tier, r.count])),
    byCategory: Object.fromEntries(catRows.map(r => [r.category, r.count])),
    byScope: Object.fromEntries(scopeRows.map(r => [r.scope, r.count])),
  };
}
