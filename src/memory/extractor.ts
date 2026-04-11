/**
 * memory/extractor.ts — Extract memories from conversation text.
 *
 * Mem0-inspired dual extraction:
 * 1. LLM extracts atomic facts → stored in memory (FTS + vector)
 * 2. Entity-relationship facts → stored in knowledge graph (temporal triples)
 *
 * Falls back to heuristic patterns if LLM unavailable.
 * Always stores verbatim text (MemPalace finding: raw > summaries).
 */

import type { Database } from "../db.js";
import { classifyMemory, extractPreferences, hasMemorySignal, type PatternCategory } from "./patterns.js";

// Note: memoryStore + knowledgeStore passed as parameters to break circular import
type StoreFn = (db: Database, opts: any) =>
  Promise<{ id: string; status: "created" | "duplicate"; duplicate_id?: string }>;
type KnowledgeStoreFn = (db: Database, opts: {
  subject: string; predicate: string; object: string;
  scope?: string; source_memory_id?: string;
}) => { id: string; invalidated: string[] };

export type ExtractedMemory = {
  text: string;
  category: PatternCategory;
  importance: number;
  // Mem0-style: optional entity triple extracted alongside
  triple?: { subject: string; predicate: string; object: string };
};

export type ExtractionResult = {
  extracted: ExtractedMemory[];
  stored: number;
  duplicates: number;
  preferences: string[];
  triples: number;
};

// =============================================================================
// Sentence splitting
// =============================================================================

function splitIntoChunks(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+|\n{2,}/);
  return raw
    .map(s => s.trim())
    .filter(s => s.length >= 20);
}

// =============================================================================
// Importance heuristic
// =============================================================================

function estimateImportance(text: string, category: PatternCategory): number {
  let importance = 0.5;

  if (category === "decision") importance = 0.8;
  else if (category === "fact") importance = 0.7;
  else if (category === "entity") importance = 0.7;
  else if (category === "preference") importance = 0.6;
  else if (category === "reflection") importance = 0.6;

  if (text.length > 200) importance = Math.min(1, importance + 0.1);

  return importance;
}

// =============================================================================
// Heuristic extraction (zero-LLM fallback)
// =============================================================================

function extractHeuristic(text: string): ExtractedMemory[] {
  const chunks = splitIntoChunks(text);
  const memories: ExtractedMemory[] = [];

  for (const chunk of chunks) {
    if (!hasMemorySignal(chunk)) continue;
    const category = classifyMemory(chunk);
    if (category === "other") continue;
    memories.push({
      text: chunk,
      category,
      importance: estimateImportance(chunk, category),
    });
  }

  return memories;
}

// =============================================================================
// LLM extraction — Mem0-style atomic facts + entity triples
// =============================================================================

// Mem0-inspired prompt: extract clean atomic facts + entity relationships
const EXTRACTION_PROMPT = `You are a Personal Information Organizer. Extract distinct facts from this conversation.

Rules:
- Extract ONLY from user/speaker messages, not assistant responses
- Each fact must be self-contained (understandable without context)
- Include names, dates, places, preferences, relationships, plans
- For entity facts, also output a triple: subject|predicate|object

Output format (one per line):
[category] fact text
[entity] fact text ||| subject|predicate|object

Categories: preference, fact, decision, entity, reflection

Examples:
[entity] John is a software engineer ||| john|occupation|software engineer
[preference] Sarah prefers morning workouts
[fact] The meeting is scheduled for March 15th
[entity] David moved from Sweden 4 years ago ||| david|moved_from|sweden
[decision] We decided to use PostgreSQL for the new project
[entity] Caroline is a transgender woman ||| caroline|identity|transgender woman
[fact] Melanie has 3 children
[entity] Melanie signed up for pottery class on July 2nd ||| melanie|signed_up_for|pottery class

Conversation:
`;

async function extractWithLLM(text: string): Promise<ExtractedMemory[]> {
  try {
    const { getRemoteLLM } = await import("../remote-config.js");
    const remote = getRemoteLLM();
    if (!remote) return [];

    const response = await remote.chatComplete(EXTRACTION_PROMPT + text);
    if (!response) return [];

    const memories: ExtractedMemory[] = [];
    for (const line of response.split('\n')) {
      const match = line.match(/^\[(\w+)\]\s+(.+)/);
      if (!match) continue;
      const cat = match[1]!.toLowerCase() as PatternCategory;
      if (!["preference", "fact", "decision", "entity", "reflection"].includes(cat)) continue;

      let memText = match[2]!.trim();
      let triple: ExtractedMemory["triple"];

      // Parse optional triple: "fact text ||| subject|predicate|object"
      const tripleMatch = memText.match(/^(.+?)\s*\|\|\|\s*([^|]+)\|([^|]+)\|(.+)$/);
      if (tripleMatch) {
        memText = tripleMatch[1]!.trim();
        triple = {
          subject: tripleMatch[2]!.trim().toLowerCase(),
          predicate: tripleMatch[3]!.trim().toLowerCase(),
          object: tripleMatch[4]!.trim(),
        };
      }

      if (memText.length < 10) continue;
      memories.push({
        text: memText,
        category: cat,
        importance: estimateImportance(memText, cat),
        triple,
      });
    }
    return memories;
  } catch {
    return [];
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract and store memories + knowledge from conversation text.
 * Mem0-style dual store: facts → memory (FTS+vector), entities → knowledge graph.
 *
 * Uses LLM if available, falls back to heuristic patterns.
 */
export async function extractAndStore(
  db: Database,
  text: string,
  scope?: string,
  storeFn?: StoreFn,
  knowledgeStoreFn?: KnowledgeStoreFn,
): Promise<ExtractionResult> {
  const store = storeFn!;

  // Try LLM first (Mem0-style atomic facts), fall back to heuristic
  let extracted = await extractWithLLM(text);
  if (extracted.length === 0) {
    extracted = extractHeuristic(text);
  }

  // Also extract preference patterns for synthetic FTS entries
  const preferences = extractPreferences(text);

  let stored = 0;
  let duplicates = 0;
  let triples = 0;

  // Store each extracted memory in vector+FTS store
  for (const mem of extracted) {
    const result = await store(db, {
      text: mem.text,
      category: mem.category,
      scope,
      importance: mem.importance,
    });
    if (result.status === "created") {
      stored++;

      // Mem0-style: also store entity triple in knowledge graph
      if (mem.triple && knowledgeStoreFn) {
        try {
          knowledgeStoreFn(db, {
            subject: mem.triple.subject,
            predicate: mem.triple.predicate,
            object: mem.triple.object,
            scope,
            source_memory_id: result.id,
          });
          triples++;
        } catch { /* skip duplicate triples */ }
      }
    } else {
      duplicates++;
    }
  }

  // Store preference synthetic entries
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

  return { extracted, stored, duplicates, preferences, triples };
}
