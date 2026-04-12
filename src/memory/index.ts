/**
 * memory/index.ts — Conversation memory layer for QMD.
 *
 * Stores and retrieves agent memories alongside document search.
 * Same SQLite DB, same embed/rerank providers, same search pipeline.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { getRemoteConfig, getRemoteLLM } from "../remote-config.js";
import { getDefaultLlamaCpp } from "../llm.js";
import { isLocalEnabled } from "../remote-config.js";
import { getDecayScore } from "./decay.js";
import { classifyMemory } from "./patterns.js";

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
export { runDecayPass, runEvictionPass, type DecayResult, type EvictionResult, type EvictionOptions } from "./decay.js";
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

export type MemoryRecallOptions = {
  query: string;
  scope?: string;
  category?: MemoryCategory;
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
// Embed helper — uses remote or local
// =============================================================================

async function embedText(text: string): Promise<number[] | null> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

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
  if (isLocalEnabled()) {
    try {
      const llm = getDefaultLlamaCpp();
      const result = await llm.embed(text);
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch {
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
  if (isLocalEnabled()) {
    try {
      const llm = getDefaultLlamaCpp();
      const result = await llm.embed(text, { isQuery: true });
      const emb = result?.embedding || null;
      if (emb) setCachedEmbedding(text, emb);
      return emb;
    } catch {
      return null;
    }
  }
  return null;
}

// =============================================================================
// Ensure memories_vec table (dynamic dimensions, same pattern as vectors_vec)
// =============================================================================

let _memoriesVecInitialized = false;

function ensureMemoriesVecTable(db: Database, dimensions: number): void {
  if (_memoriesVecInitialized) return;
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'`
  ).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions) {
      _memoriesVecInitialized = true;
      return;
    }
    // Dimension mismatch — drop and recreate
    db.exec(`DROP TABLE IF EXISTS memories_vec`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE memories_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`
  );
  _memoriesVecInitialized = true;
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
      db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(id, new Float32Array(embedding));
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
            insertVecRef.stmt = db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`);
          }
          insertVecRef.stmt.run(id, new Float32Array(emb));
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

  // 1+2. FTS and embedding run in parallel (embedding is the slow part)
  const embeddingPromise = embedQuery(query);

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

  // Vector search (await the embedding that started in parallel with FTS)
  const queryEmbedding = await embeddingPromise;
  if (queryEmbedding) {
    try {
      const vecResults = db.prepare(
        `SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?`
      ).all(new Float32Array(queryEmbedding), limit * 3) as { id: string; distance: number }[];

      for (const r of vecResults) {
        const similarity = 1 - r.distance;
        if (similarity < 0.3) continue;
        const mem = getById.get(r.id) as Memory | null;
        if (mem) addResult(mem, similarity);
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
      db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(options.id, new Float32Array(embedding));
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
