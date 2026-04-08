/**
 * memory/extractor.ts — Extract memories from conversation text.
 *
 * Two modes:
 * 1. Heuristic (zero-LLM): split text into sentences, classify each with regex patterns
 * 2. LLM-assisted: send text to configured query expansion provider for structured extraction
 *
 * Always stores verbatim text (MemPalace finding: raw > extracted summaries).
 * Classification is for tagging/filtering, not for discarding content.
 */

import type { Database } from "../db.js";
import { classifyMemory, extractPreferences, hasMemorySignal, type PatternCategory } from "./patterns.js";

// Note: memoryStore is passed as a parameter to break circular import
// (index.ts exports from extractor.ts, extractor.ts was importing from index.ts)
type StoreFn = (db: Database, opts: any) =>
  Promise<{ id: string; status: "created" | "duplicate"; duplicate_id?: string }>;

export type ExtractedMemory = {
  text: string;
  category: PatternCategory;
  importance: number;
};

export type ExtractionResult = {
  extracted: ExtractedMemory[];
  stored: number;
  duplicates: number;
  preferences: string[];
};

// =============================================================================
// Sentence splitting
// =============================================================================

function splitIntoChunks(text: string): string[] {
  // Split on sentence boundaries, keeping minimum useful length
  const raw = text.split(/(?<=[.!?])\s+|\n{2,}/);
  return raw
    .map(s => s.trim())
    .filter(s => s.length >= 20); // skip noise
}

// =============================================================================
// Importance heuristic
// =============================================================================

function estimateImportance(text: string, category: PatternCategory): number {
  let importance = 0.5;

  // Decisions and reflections are usually more important
  if (category === "decision") importance = 0.7;
  if (category === "reflection") importance = 0.7;
  if (category === "preference") importance = 0.6;

  // Emphasis words boost importance
  if (/\b(?:critical|important|crucial|essential|must|always|never)\b/i.test(text)) {
    importance = Math.min(1, importance + 0.2);
  }

  // Longer, more detailed memories are usually more important
  if (text.length > 200) importance = Math.min(1, importance + 0.1);

  return importance;
}

// =============================================================================
// Heuristic extraction (zero-LLM)
// =============================================================================

function extractHeuristic(text: string): ExtractedMemory[] {
  const chunks = splitIntoChunks(text);
  const memories: ExtractedMemory[] = [];

  for (const chunk of chunks) {
    if (!hasMemorySignal(chunk)) continue;
    const category = classifyMemory(chunk);
    if (category === "other") continue; // only extract classified memories
    memories.push({
      text: chunk,
      category,
      importance: estimateImportance(chunk, category),
    });
  }

  return memories;
}

// =============================================================================
// LLM extraction (optional, uses query expansion provider)
// =============================================================================

const EXTRACTION_PROMPT = `Extract facts, preferences, decisions, and learnings from this conversation text.
Return one memory per line in this exact format:
[category] text

Categories: preference, fact, decision, entity, reflection
Only extract clear, specific statements. Skip greetings, filler, and vague text.

Example output:
[preference] I prefer TypeScript over JavaScript for backend work
[decision] We decided to use PostgreSQL instead of MongoDB
[fact] The API rate limit is 100 requests per minute
[entity] David works at Tanarchy
[reflection] I learned that caching DNS lookups saves 200ms per request

Conversation text:
`;

// NOTE: LLM extraction via expandQuery was broken (expandQuery returns lex/vec/hyde
// format, not free-form extraction). Heuristic extraction is the primary path.
// MemPalace benchmarks show raw verbatim + heuristic patterns outperforms
// LLM extraction (96.6% vs Mem0's 30-45%). LLM extraction deferred to when
// we add a direct chat completions call path.

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract and store memories from conversation text.
 * Uses LLM if available, falls back to heuristic patterns.
 * Stores verbatim text with category tags. Dedup handled by memoryStore.
 */
export async function extractAndStore(
  db: Database,
  text: string,
  scope?: string,
  storeFn?: StoreFn,
): Promise<ExtractionResult> {
  // storeFn is injected by the caller (memory/index.ts) to break circular import
  const store = storeFn!;

  // Heuristic extraction (zero-LLM, proven effective by MemPalace benchmarks)
  const extracted = extractHeuristic(text);

  // Also extract preference patterns for synthetic FTS entries
  const preferences = extractPreferences(text);

  let stored = 0;
  let duplicates = 0;

  // Store each extracted memory
  for (const mem of extracted) {
    const result = await store(db, {
      text: mem.text,
      category: mem.category,
      scope,
      importance: mem.importance,
    });
    if (result.status === "created") stored++;
    else duplicates++;
  }

  // Store preference synthetic entries (lower importance, tagged as preference)
  for (const pref of preferences) {
    const result = await store(db, {
      text: pref,
      category: "preference",
      scope,
      importance: 0.4,
    });
    if (result.status === "created") stored++;
    else duplicates++;
  }

  return { extracted, stored, duplicates, preferences };
}
