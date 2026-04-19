/**
 * Phase 5 fact extraction — shared infrastructure for KG injection (5a) and
 * fact-augmented embedding keys (5b). Design:
 * devnotes/architecture/phase5-kg-and-fact-aug-design.md
 *
 * One LLM call per memory turn → {facts, triples}. Cached by
 * sha256(prompt_template + turn_text) so re-runs are free.
 *
 * Not invoked automatically at memoryStore — the design is BATCH ingest.
 * See `scripts/extract-facts-batch.mjs` for the runner (adds extracted
 * facts/triples to an existing memory DB).
 */

import { createHash } from "node:crypto";

/** A single extracted fact: self-contained, ≤20 tokens, no pronouns. */
export type Fact = string;

/** Subject-Predicate-Object triple for the knowledge graph side. */
export type Triple = {
  subject: string;
  predicate: string;
  object: string;
};

export type ExtractionResult = {
  facts: Fact[];
  triples: Triple[];
};

/**
 * Prompt template for fact + triple extraction.
 * Phase-locked — changes to this string invalidate the entire cache so
 * bump PROMPT_VERSION when you touch it.
 */
export const FACT_EXTRACTION_PROMPT_VERSION = 1;

export function buildFactExtractionPrompt(turnText: string): string {
  return `You are extracting structured memories from a conversation turn. Output JSON:

{
  "facts": ["atomic fact 1", "atomic fact 2", ...],
  "triples": [
    {"subject": "user", "predicate": "likes", "object": "hiking"},
    ...
  ]
}

Rules:
- Facts capture user-specific preferences, decisions, or stable state
- Each fact is self-contained (no pronouns), ≤20 tokens
- Triples use canonical entity names (lowercase, underscored)
- Facts and triples are complementary: a triple is the graph view of a fact
- Return {"facts": [], "triples": []} if the turn has no new information

Turn:
${turnText.trim()}

JSON:`;
}

/**
 * Deterministic cache key for an extraction call. Keyed on the prompt
 * template version + turn text — lets us invalidate cache by bumping version
 * without losing identity on unchanged turns.
 */
export function factExtractionCacheKey(turnText: string): string {
  const h = createHash("sha256");
  h.update(`fact-extract|v${FACT_EXTRACTION_PROMPT_VERSION}|`);
  h.update(turnText.trim());
  return "fact-" + h.digest("hex").slice(0, 24);
}

/**
 * Parse the LLM's raw response into an ExtractionResult. Tolerant of:
 * - Leading/trailing whitespace or prose
 * - Markdown code fences around the JSON
 * - Missing optional fields (default to empty arrays)
 * Returns null if no valid JSON object can be extracted.
 */
export function parseFactExtraction(raw: string): ExtractionResult | null {
  // Strip common prose preambles ("Here's the JSON:", etc.) + code fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  // Find first { ... } balanced-ish block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const facts: Fact[] = Array.isArray(obj.facts)
      ? obj.facts.filter((x: unknown) => typeof x === "string" && x.length > 0)
      : [];
    const triples: Triple[] = Array.isArray(obj.triples)
      ? obj.triples
          .filter((t: unknown) => {
            if (!t || typeof t !== "object") return false;
            const r = t as Record<string, unknown>;
            return typeof r.subject === "string" && typeof r.predicate === "string" && typeof r.object === "string";
          })
          .map((t: unknown) => {
            const r = t as Record<string, string>;
            return { subject: r.subject, predicate: r.predicate, object: r.object };
          })
      : [];
    return { facts, triples };
  } catch {
    return null;
  }
}

/**
 * Concatenates facts into a single searchable text blob suitable for
 * embedding. Each fact on its own line. Returns "" if no facts.
 * This is what gets stored in memories.fact_text and embedded into
 * memories.fact_embedding.
 */
export function factsToEmbeddableText(facts: Fact[]): string {
  return facts.filter((f) => f && f.trim().length > 0).map((f) => f.trim()).join("\n");
}
