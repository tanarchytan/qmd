/**
 * memory/knowledge.ts — Temporal knowledge graph.
 *
 * Store entity-relationship triples with time validity windows.
 * From MemPalace: "What was true at time X?" is a SQL query, not a search.
 *
 * Entities are auto-deduped via slug normalization:
 *   "David Gillot" → "david_gillot"
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";

// =============================================================================
// Types
// =============================================================================

export type KnowledgeEntry = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number | null;
  valid_until: number | null;
  confidence: number;
  source_memory_id: string | null;
  created_at: number;
};

export type KnowledgeStoreOptions = {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: number;
  confidence?: number;
  source_memory_id?: string;
};

export type KnowledgeQueryOptions = {
  subject?: string;
  predicate?: string;
  object?: string;
  as_of?: number;  // timestamp — return facts valid at this time
  limit?: number;
};

// =============================================================================
// Entity slug normalization (from MemPalace)
// =============================================================================

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// =============================================================================
// Knowledge CRUD
// =============================================================================

/**
 * Store a fact. Auto-invalidates conflicting prior facts on the same
 * subject+predicate (sets valid_until = now on the old entry).
 */
export function knowledgeStore(
  db: Database,
  options: KnowledgeStoreOptions
): { id: string; invalidated: string[] } {
  const subject = toSlug(options.subject);
  const predicate = options.predicate.toLowerCase().trim();
  const object = options.object.trim();
  const now = Date.now();
  const validFrom = options.valid_from ?? now;
  const confidence = Math.max(0, Math.min(1, options.confidence ?? 1.0));

  // Auto-invalidate conflicting prior facts
  const existing = db.prepare(`
    SELECT id, object FROM knowledge
    WHERE subject = ? AND predicate = ? AND valid_until IS NULL
  `).all(subject, predicate) as { id: string; object: string }[];

  const invalidated: string[] = [];
  for (const old of existing) {
    if (old.object !== object) {
      db.prepare(`UPDATE knowledge SET valid_until = ? WHERE id = ?`).run(now, old.id);
      invalidated.push(old.id);
    } else {
      // Same fact already exists and is valid — just return it
      return { id: old.id, invalidated: [] };
    }
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO knowledge (id, subject, predicate, object, valid_from, confidence, source_memory_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, subject, predicate, object, validFrom, confidence, options.source_memory_id ?? null, now);

  return { id, invalidated };
}

/**
 * Query facts, optionally filtered by subject/predicate/object and time.
 * as_of: return only facts valid at that timestamp (valid_from <= as_of AND (valid_until IS NULL OR valid_until > as_of))
 */
export function knowledgeQuery(
  db: Database,
  options: KnowledgeQueryOptions
): KnowledgeEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.subject) {
    conditions.push("subject = ?");
    params.push(toSlug(options.subject));
  }
  if (options.predicate) {
    conditions.push("predicate = ?");
    params.push(options.predicate.toLowerCase().trim());
  }
  if (options.object) {
    conditions.push("object LIKE ?");
    params.push(`%${options.object}%`);
  }
  if (options.as_of !== undefined) {
    conditions.push("(valid_from IS NULL OR valid_from <= ?)");
    params.push(options.as_of);
    conditions.push("(valid_until IS NULL OR valid_until > ?)");
    params.push(options.as_of);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit ?? 50;

  return db.prepare(`
    SELECT * FROM knowledge ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as KnowledgeEntry[];
}

/**
 * Invalidate a fact by setting valid_until to now.
 */
export function knowledgeInvalidate(
  db: Database,
  id: string
): { invalidated: boolean } {
  const existing = db.prepare(`SELECT id FROM knowledge WHERE id = ? AND valid_until IS NULL`).get(id);
  if (!existing) return { invalidated: false };

  db.prepare(`UPDATE knowledge SET valid_until = ? WHERE id = ?`).run(Date.now(), id);
  return { invalidated: true };
}

/**
 * List all known entities (unique subjects).
 */
export function knowledgeEntities(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT subject FROM knowledge ORDER BY subject`).all() as { subject: string }[];
  return rows.map(r => r.subject);
}

/**
 * Get all current (valid) facts about a subject.
 */
export function knowledgeAbout(db: Database, subject: string): KnowledgeEntry[] {
  const slug = toSlug(subject);
  return db.prepare(`
    SELECT * FROM knowledge WHERE subject = ? AND valid_until IS NULL ORDER BY predicate
  `).all(slug) as KnowledgeEntry[];
}
