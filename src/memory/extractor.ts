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

/**
 * Importance scale (quality fix #9):
 *   0.4   — synthetic preference bridge entries (low; auxiliary signal)
 *   0.5   — heuristic fallback / unknown category
 *   0.6   — reflections, preferences (medium-low; subjective)
 *   0.7   — facts, entities (default for raw extracted facts)
 *   0.75  — entity facts (slight bump for strong typing)  [used by knowledge.ts synthesis]
 *   0.8   — decisions (medium-high; explicit choices)
 *   0.85  — entity profile/timeline syntheses             [knowledge.ts:consolidateEntityFacts]
 *   +0.1  — long texts (>200 chars get bonus, capped at 1.0)
 *
 * Decay scoring uses importance × frequency × recency. Higher importance →
 * slower decay → memory survives in working/core tier longer.
 */
/**
 * Approximate entity density: ratio of capitalized tokens (proper-noun
 * proxy) to total alphanumeric tokens. Higher values suggest the text
 * names specific people / places / things and is more recall-worthy.
 * Cheap and zero-dependency — no NER runtime.
 */
function entityDensity(text: string): number {
  const tokens = text.match(/[A-Za-z][\w'-]+/g) || [];
  if (tokens.length === 0) return 0;
  // Skip sentence-initial caps by only counting non-first tokens
  // (catches "John" but not "The" at the start of a sentence).
  let proper = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[A-Z][a-z]+/.test(t) && !STOP_CAPS.has(t.toLowerCase())) {
      // First-word penalty: only count if not immediately after . ! ? or at start
      if (i === 0) continue;
      proper++;
    }
  }
  return Math.min(1, proper / Math.max(1, tokens.length));
}

// Common sentence-initial words that tokenize as capitalized but aren't
// proper nouns. Keeps entityDensity from treating "The/That/This/…" as entities.
const STOP_CAPS = new Set([
  "the", "that", "this", "these", "those", "there", "then", "than",
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "if", "unless", "although", "while", "since", "because",
  "yes", "no", "maybe", "okay", "ok",
]);

/**
 * Look for markers that the text is making a decision or commitment.
 * Decisions are long-lived signal and deserve a small importance bump
 * on top of the category score.
 */
const DECISION_PATTERNS = [
  /\b(?:decided|decide|chose|choose|picked|going to|will|plan(?:ned|ning)? to)\b/i,
  /\b(?:committed to|agreed to|settled on|opted for)\b/i,
];

function hasDecisionSignal(text: string): boolean {
  return DECISION_PATTERNS.some(re => re.test(text));
}

/**
 * 4-component importance estimator.
 *
 * Category (primary) + length (modest bump) stay as before. Added:
 *   - entityDensity bump: up to +0.10 when text is packed with proper nouns
 *   - decisionSignal bump: +0.05 when commitment language is present
 *
 * Bumps are capped so the function always returns values in [0, 1].
 * Approach inspired by Tinkerclaw Instant Recall's 4-component score
 * (entity_density + decision + engagement + recency) — we skip the
 * engagement signal because it duplicates the length component and
 * recency is handled by the decay engine, not at ingest time.
 */
function estimateImportance(text: string, category: PatternCategory): number {
  let importance = 0.5;

  if (category === "decision") importance = 0.8;
  else if (category === "fact") importance = 0.7;
  else if (category === "entity") importance = 0.7;
  else if (category === "preference") importance = 0.6;
  else if (category === "reflection") importance = 0.6;

  if (text.length > 200) importance += 0.1;

  const density = entityDensity(text);
  if (density >= 0.1) importance += Math.min(0.1, density * 0.5);

  if (hasDecisionSignal(text) && category !== "decision") {
    importance += 0.05;
  }

  return Math.max(0, Math.min(1, importance));
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

// Mem0-inspired prompt: extract atomic facts + entity triples + reflections
// (cat 18 fix: combined reflection extraction into one LLM call to halve API cost)
const EXTRACTION_PROMPT = `You are a Personal Information Organizer. Extract distinct facts AND cross-event reflections from this conversation.

Rules:
- Extract from user/speaker messages
- Each fact must be self-contained (understandable without context)
- Include names, dates, places, preferences, relationships, plans
- For entity facts, also output a triple: subject|predicate|object
- Reflections must span MULTIPLE events — capture motivations, commonalities, patterns, cause/effect, emotional arcs

Output format (one per line):
[category] fact text
[entity] fact text ||| subject|predicate|object
[reflection] cross-event insight

Categories: preference, fact, decision, entity, reflection

Examples (generic):
[entity] User-A is a software engineer ||| user-a|occupation|software engineer
[preference] User-B prefers morning workouts
[fact] The meeting is scheduled for March 15th
[entity] User-C moved from country-X 4 years ago ||| user-c|moved_from|country-x
[decision] User-A and User-B decided to use PostgreSQL for the new project
[entity] User-D has 3 children ||| user-d|num_children|3
[fact] User-D's kids enjoy outdoor activities
[reflection] User-A and User-B both started their businesses after losing their jobs
[reflection] User-C's interest in counseling stems from support received during her own transition

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
      // Includes 'reflection' so the same prompt covers both fact extraction and reflection
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
  metadata?: Record<string, unknown>,
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
      metadata,
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
      metadata,
    });
    if (result.status === "created") stored++;
    else duplicates++;
  }

  return { extracted, stored, duplicates, preferences, triples };
}

// =============================================================================
// Reflection extraction (cat 18) — DEPRECATED standalone path
// =============================================================================
// Reflections are now extracted as part of extractAndStore via the unified
// EXTRACTION_PROMPT. This function is kept for backwards compatibility and as
// a no-op so existing call sites still type-check.
//
// (cat 18 quality fix #4: combined into one LLM call to halve ingest API cost)
export async function extractReflections(
  _db: Database,
  _text: string,
  _scope: string | undefined,
  _storeFn: StoreFn
): Promise<{ extracted: number; stored: number; duplicates: number }> {
  // No-op: reflections are extracted by extractAndStore now.
  return { extracted: 0, stored: 0, duplicates: 0 };
}
