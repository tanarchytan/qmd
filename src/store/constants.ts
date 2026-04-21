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
export const CHUNK_SIZE_TOKENS = parseInt(process.env.LOTL_CHUNK_SIZE_TOKENS ?? "900", 10);
export const CHUNK_OVERLAP_TOKENS = Math.floor(CHUNK_SIZE_TOKENS * 0.15);
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4;
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4;
export const CHUNK_WINDOW_TOKENS = parseInt(process.env.LOTL_CHUNK_WINDOW_TOKENS ?? "200", 10);
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4;

// Hybrid query: strong BM25 signal detection thresholds
export const STRONG_SIGNAL_MIN_SCORE = 0.85;
export const STRONG_SIGNAL_MIN_GAP = 0.15;
// Rerank pool: how many candidates feed the cross-encoder. Bigger pool =
// more chances the answer is inside for rerank to find, at linear cost
// in rerank wall. Default 40 (Stage 9). Env-overridable for sweeps.
export const RERANK_CANDIDATE_LIMIT = Number(process.env.LOTL_MEMORY_RERANK_CANDIDATE_LIMIT ?? 40);
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
// Vec KNN pool multiplier: controls vec candidate pool size.
export const MEMORY_VEC_K_MULTIPLIER = 3;
// RRF fusion weights for memory recall. Starting with agentmemory's
// validated defaults (0.4 bm25 / 0.6 vec). To be swept in Phase 3.
export const MEMORY_RRF_K = 60;
// RRF fusion weights. Swept at n=500 LME (2026-04-16):
// 0.9/0.1 best MRR (0.918) + pref MRR (0.741) of BM25-heavy configs.
// Vec is weak (mxbai-xs q8) — more vec weight collapses s-user.
// Path to better vec: fact-augmented embedding keys (see ROADMAP).
// Env overrides let the Phase 2 BM25/vec re-sweep flip ratios without a
// recompile. Weights should sum to 1.0 but nothing enforces it.
export const MEMORY_RRF_W_BM25 = Number(process.env.LOTL_MEMORY_RRF_W_BM25 ?? 0.9);
export const MEMORY_RRF_W_VEC = Number(process.env.LOTL_MEMORY_RRF_W_VEC ?? 0.1);
// Temporal window retrieval (3rd RRF list, fires only when query has
// a parseable time reference). Weight 0.1 — on LME this is a no-op
// because all memories have the same created_at (ingestion time), but
// in production with real message timestamps it shifts recency-relevant
// results up. Swept 0.1/0.3 at n=500 LME: byte-identical to no-temporal.
export const MEMORY_RRF_W_TIME = 0.1;
// Rerank blend weights. Both sides are min-max normalized to [0,1] in
// memoryRecall before the blend (src/memory/index.ts:1557-1600), so the
// ratio below is meaningful — not a score-dominance artifact.
//
// History:
//   Old additive pipeline (pre-RRF): 0.1/0.9 was optimal (MRR 0.937 n=500).
//   RRF pipeline (2026-04-16): the historical "rerank regresses on RRF"
//     finding was measured on a buggy run where rerank silently no-op'd
//     for every non-legacy model (filename hardcoded; fixed 2026-04-19 in
//     commit 9cba9bc). Actual RRF + rerank blend behavior is an open
//     question pending the clean reruns landing 2026-04-19.
//   0.7/0.3 was conservative choice for v1 — favoring the RRF signal
//     while still admitting rerank corrections. Revisit after reruns.
//
// Rerank still defaults OFF in memoryRecall (LOTL_MEMORY_RERANK=on to enable)
// because cross-encoder per-query cost is 4-5 s on CPU — too slow for
// production memory recall latency targets.
//
// Env overrides let the blend be re-swept without a recompile. Both sum is
// not enforced (allows pure-rerank α=0/1 or RRF-only α=1/0).
export const MEMORY_RERANK_BLEND_ORIGINAL = Number(process.env.LOTL_MEMORY_RERANK_BLEND_ORIGINAL ?? 0.7);
export const MEMORY_RERANK_BLEND_RERANK = Number(process.env.LOTL_MEMORY_RERANK_BLEND_RERANK ?? 0.3);

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

// Synonym map for BM25 query expansion. Curated for preference/temporal
// patterns common in agent memory queries. Each listed term expands into
// OR-joined synonyms at FTS query build time.
//
// Keep small — each added term is noise for queries where it doesn't
// match. Only include cases where the query and gold session reliably
// use different words for the same concept (preference verbs, common
// nouns with paraphrases, temporal modifiers).
export const MEMORY_SYNONYMS: Record<string, string[]> = {
  // Preference verbs (query often uses "suggest", gold says "like/prefer")
  suggest: ["recommend", "propose", "advice"],
  recommend: ["suggest", "propose", "advice"],
  tips: ["advice", "suggestion", "recommendation"],
  // Meals
  dinner: ["meal", "food", "supper"],
  breakfast: ["meal", "morning"],
  lunch: ["meal", "noon"],
  // Accommodation / travel
  hotel: ["accommodation", "lodging", "stay"],
  trip: ["travel", "visit", "vacation"],
  // Common items
  phone: ["mobile", "smartphone", "cellphone"],
  car: ["vehicle", "auto"],
  // Activities
  activities: ["hobbies", "pastime", "recreation"],
  exercise: ["workout", "training", "fitness"],
  // Temporal shortcuts
  recently: ["lately", "latest"],
  "yesterday": ["recent"],
};
