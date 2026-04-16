// =============================================================================
// Configuration constants and search tunables
// =============================================================================

export const DEFAULT_EMBED_MODEL = "embeddinggemma";
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";
export const DEFAULT_QUERY_MODEL = "Qwen/Qwen3-1.7B";
export const DEFAULT_GLOB = "**/*.md";
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024; // 10KB
export const DEFAULT_EMBED_MAX_DOCS_PER_BATCH = 64;
export const DEFAULT_EMBED_MAX_BATCH_BYTES = 64 * 1024 * 1024; // 64MB

// Chunking: 900 tokens per chunk with 15% overlap (env-configurable)
export const CHUNK_SIZE_TOKENS = parseInt(process.env.QMD_CHUNK_SIZE_TOKENS ?? "900", 10);
export const CHUNK_OVERLAP_TOKENS = Math.floor(CHUNK_SIZE_TOKENS * 0.15);
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4;
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4;
export const CHUNK_WINDOW_TOKENS = parseInt(process.env.QMD_CHUNK_WINDOW_TOKENS ?? "200", 10);
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4;

// Hybrid query: strong BM25 signal detection thresholds
export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
export const RERANK_CANDIDATE_LIMIT = 40;
// RRF and scoring tunables
export const RRF_K = 60;
export const WEIGHT_FTS = 2.0;
export const WEIGHT_VEC = 1.0;
export const BLEND_RRF_TOP3 = 0.75;
export const BLEND_RRF_TOP10 = 0.60;
export const BLEND_RRF_REST = 0.40;

// Memory recall tunables (validated at n=500 LME, 2026-04-16)
// FTS over-fetch: 10× beats 20× (+0.4pp recall_any@5, +0.7pp R@5).
// 5× loses recall. 10× is the validated sweet spot.
export const MEMORY_FTS_OVERFETCH = 10;
// Vec KNN pool multiplier: 3/5/10 are byte-identical on LME n=500 —
// vec signal is noise in additive fusion, so pool size doesn't matter.
export const MEMORY_VEC_K_MULTIPLIER = 3;
// Rerank blend: 40% original + 60% rerank score. Cross-encoder logits
// are min-max normalized before blending.
export const MEMORY_RERANK_BLEND_ORIGINAL = 0.4;
export const MEMORY_RERANK_BLEND_RERANK = 0.6;

/** Weight for intent terms relative to query terms (1.0) in snippet scoring */
export const INTENT_WEIGHT_SNIPPET = 0.3;

/** Weight for intent terms relative to query terms (1.0) in chunk selection */
export const INTENT_WEIGHT_CHUNK = 0.5;

// Common stop words filtered from intent strings before tokenization.
// Seeded from finetune/reward.py KEY_TERM_STOPWORDS, extended with common
// 2-3 char function words so the length threshold can drop to >1 and let
// short domain terms (API, SQL, LLM, CPU, CDN, ...) survive.
const INTENT_STOP_WORDS = new Set([
  // 2-char function words
  "am", "an", "as", "at", "be", "by", "do", "he", "if",
  "in", "is", "it", "me", "my", "no", "of", "on", "or", "so",
  "to", "up", "us", "we",
  // 3-char function words
  "all", "and", "any", "are", "but", "can", "did", "for", "get",
  "has", "her", "him", "his", "how", "its", "let", "may", "not",
  "our", "out", "the", "too", "was", "who", "why", "you",
  // 4+ char common words
  "also", "does", "find", "from", "have", "into", "more", "need",
  "show", "some", "tell", "that", "them", "this", "want", "what",
  "when", "will", "with", "your",
  // Search-context noise
  "about", "looking", "notes", "search", "where", "which",
]);

/**
 * Extract meaningful terms from an intent string, filtering stop words and punctuation.
 * Uses Unicode-aware punctuation stripping so domain terms like "API" survive.
 * Returns lowercase terms suitable for text matching.
 */
export function extractIntentTerms(intent: string): string[] {
  return intent.toLowerCase().split(/\s+/)
    .map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(t => t.length > 1 && !INTENT_STOP_WORDS.has(t));
}
