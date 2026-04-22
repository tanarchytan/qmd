/**
 * memory/patterns.ts — Zero-LLM heuristic classification for memories.
 *
 * Sources:
 * - Preference extraction patterns: MemPalace PREF_PATTERNS (hybrid_v3, +0.6% recall)
 * - Category names (6 types): memory-lancedb-pro SmartExtractor
 * - Decision/fact/entity/reflection patterns: custom heuristics
 */

export type PatternCategory = "preference" | "fact" | "decision" | "entity" | "reflection" | "other";

// =============================================================================
// Category detection patterns
// =============================================================================

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  // From MemPalace PREF_PATTERNS (hybrid_v3 benchmark improvement)
  preference: [
    /\bi (?:usually |always )?prefer\b/i,
    /\bi (?:always |usually )(?:use|do|go with)\b/i,
    /\bi don'?t (?:like|want|use)\b/i,
    /\bi (?:love|hate|enjoy|avoid)\b/i,
    /\bmy (?:favorite|preferred|go-to)\b/i,
    /\bi (?:tend to|lean toward)\b/i,
    /\bi(?:'m| am) (?:a fan of|not a fan of)\b/i,
    /\bi still remember\b/i,
    /\bi used to\b/i,
    /\bwhen i was\b/i,
    /\bgrowing up\b/i,
    /\bi've been having (?:trouble|issues?|problems?) with\b/i,
    /\bi've been feeling\b/i,
    /\bi(?:'m| am) (?:worried|concerned) about\b/i,
    /\bi want to\b/i,
    /\bi'm thinking (?:about|of)\b/i,
  ],
  // Custom heuristics
  decision: [
    /\bwe (?:decided|went with|chose|picked)\b/i,
    /\blet'?s (?:use|go with|try|pick|switch to)\b/i,
    /\bthe decision (?:is|was)\b/i,
    /\bwe(?:'re| are) going (?:to|with)\b/i,
    /\bi'?ve decided\b/i,
    /\bafter (?:consideration|discussion|review)\b/i,
  ],
  fact: [
    /\b(?:actually|turns out|apparently)\b/i,
    /\b(?:it is|it's|that's) (?:a |the )?(?:fact|truth|case)\b/i,
    /\b(?:works at|lives in|born in|graduated from)\b/i,
    /\b(?:the (?:answer|solution|reason|cause) (?:is|was))\b/i,
    /\b(?:as of|since|starting from)\b/i,
  ],
  entity: [
    /\b[A-Z][a-z]+ (?:is|was|works at|lives in)\b/,
    /\b[A-Z][a-z]+ (?:said|asked|mentioned|told me)\b/,
    /\b(?:the|our) (?:team|project|company|server|service) (?:is |was |called )/i,
  ],
  reflection: [
    /\bi (?:realized|noticed|learned|discovered)\b/i,
    /\bin hindsight\b/i,
    /\blooking back\b/i,
    /\bthe (?:lesson|takeaway|insight) (?:is|was)\b/i,
    /\bi should(?:'ve| have)\b/i,
    /\bnext time\b/i,
  ],
};

// =============================================================================
// Preference extraction (for synthetic FTS entries)
// From MemPalace hybrid_v3: bridges vocabulary gap between
// how preferences are stated and how questions about them are asked.
// =============================================================================

const PREFERENCE_EXTRACTION_PATTERNS: RegExp[] = [
  /\bi (?:usually |always )?prefer ([^\n]{5,80})/i,
  /\bi (?:always |usually )(?:use|do|go with) ([^\n]{5,80})/i,
  /\bi don'?t (?:like|want|use) ([^\n]{5,80})/i,
  /\bi (?:love|hate|enjoy|avoid) ([^\n]{5,80})/i,
  /\bmy (?:favorite|preferred|go-to) (?:is |are )?([^\n]{5,80})/i,
  /\bi (?:tend to|lean toward) ([^\n]{5,80})/i,
  /\bi've been having (?:trouble|issues?|problems?) with ([^\n]{5,60})/i,
  /\bi(?:'m| am) (?:worried|concerned) about ([^\n]{5,60})/i,
  /\bi want to ([^\n]{5,60})/i,
  /\bi'm thinking (?:about|of) ([^\n]{5,60})/i,
];

// =============================================================================
// Public API
// =============================================================================

/**
 * Detect the most likely category for a memory text.
 * Returns the category with the most pattern matches, or "other".
 */
export function classifyMemory(text: string): PatternCategory {
  let bestCategory: PatternCategory = "other";
  let bestScore = 0;

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    let score = 0;
    for (const pattern of patterns) {
      if (pattern.test(text)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as PatternCategory;
    }
  }

  return bestCategory;
}

/**
 * Extract preference mentions from text.
 * Returns synthetic "User mentioned: ..." strings for FTS indexing.
 */
export function extractPreferences(text: string): string[] {
  const preferences: string[] = [];
  for (const pattern of PREFERENCE_EXTRACTION_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const pref = match[1].trim().replace(/[.!?,;:]+$/, "");
      if (pref.length >= 5) {
        preferences.push(`User mentioned: ${pref}`);
      }
    }
  }
  return preferences;
}

/**
 * Quick check: does this text contain any memory-worthy signal?
 */
export function hasMemorySignal(text: string): boolean {
  for (const patterns of Object.values(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}
