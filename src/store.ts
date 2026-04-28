/**
 * Lotl Store - Facade module (re-exports from submodules)
 *
 * This module re-exports all public APIs from src/store/ submodules.
 * External consumers keep importing from "./store.js" — backward compatible.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

// --- Constants ---
export {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_GLOB,
  DEFAULT_MULTI_GET_MAX_BYTES,
  DEFAULT_EMBED_MAX_DOCS_PER_BATCH,
  DEFAULT_EMBED_MAX_BATCH_BYTES,
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_TOKENS,
  CHUNK_WINDOW_CHARS,
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
  RERANK_CANDIDATE_LIMIT,
  RRF_K,
  WEIGHT_FTS,
  WEIGHT_VEC,
  BLEND_RRF_TOP3,
  BLEND_RRF_TOP10,
  BLEND_RRF_REST,
  INTENT_WEIGHT_SNIPPET,
  INTENT_WEIGHT_CHUNK,
  extractIntentTerms,
} from "./store/constants.js";

// --- Types ---
export type {
  Store,
  DocumentResult,
  SearchResult,
  RankedResult,
  RRFContributionTrace,
  RRFScoreTrace,
  HybridQueryExplain,
  DocumentNotFound,
  MultiGetResult,
  CollectionInfo,
  IndexStatus,
  IndexHealthInfo,
  SnippetResult,
  RankedListMeta,
  ExpandedQuery,
  ChunkStrategy,
} from "./store/types.js";

// --- Path utilities ---
export {
  homedir,
  isAbsolutePath,
  normalizePathSeparators,
  getRelativePathFromPrefix,
  resolve,
  enableProductionMode,
  _resetProductionModeForTesting,
  getDefaultDbPath,
  getPwd,
  getRealPath,
  normalizeVirtualPath,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  resolveVirtualPath,
  toVirtualPath,
} from "./store/path.js";
export type { VirtualPath } from "./store/path.js";

// --- Chunking ---
export {
  scanBreakPoints,
  findCodeFences,
  isInsideCodeFence,
  findBestCutoff,
  mergeBreakPoints,
  chunkDocumentWithBreakPoints,
  chunkDocument,
  chunkDocumentAsync,
  chunkDocumentByTokens,
  BREAK_PATTERNS,
} from "./store/chunking.js";
export type { BreakPoint, CodeFenceRegion } from "./store/chunking.js";

// --- Store collections ---
export {
  getStoreCollections,
  getStoreCollection,
  getStoreGlobalContext,
  getStoreContexts,
  upsertStoreCollection,
  deleteStoreCollection,
  renameStoreCollection,
  updateStoreContext,
  removeStoreContext,
  setStoreGlobalContext,
  syncConfigToDb,
} from "./store/store-collections.js";

// --- DB init ---
export {
  verifySqliteVecLoaded,
  isSqliteVecAvailable,
} from "./store/db-init.js";

// --- Context ---
export {
  getContextForPath,
  getContextForFile,
  getCollectionByName,
  listCollections,
  removeCollection,
  renameCollection,
  getAllCollections,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
} from "./store/context.js";

// --- Documents ---
export {
  getDocid,
  handelize,
  hashContent,
  extractTitle,
  insertContent,
  insertDocument,
  findActiveDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  normalizeDocid,
  isDocid,
  findDocumentByDocid,
  findSimilarFiles,
  matchFilesByGlob,
  findDocument,
  getDocumentBody,
  findDocuments,
  formatQueryForEmbedding,
  formatDocForEmbedding,
} from "./store/documents.js";

// --- Maintenance ---
export {
  getHashesNeedingEmbedding,
  getIndexHealth,
  getCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  deleteLLMCache,
  deleteInactiveDocuments,
  cleanupOrphanedContent,
  cleanupOrphanedVectors,
  vacuumDatabase,
  getStatus,
} from "./store/maintenance.js";

// --- Search ---
export {
  sanitizeFTS5Term,
  validateSemanticQuery,
  validateLexQuery,
  searchFTS,
  searchVec,
  getHashesForEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  expandQuery,
  rerank,
  reciprocalRankFusion,
  buildRrfTrace,
  extractSnippet,
  addLineNumbers,
  hybridQuery,
  vectorSearchQuery,
  structuredSearch,
} from "./store/search.js";
export type {
  SearchHooks,
  HybridQueryOptions,
  HybridQueryResult,
  VectorSearchOptions,
  VectorSearchResult,
  StructuredSearchOptions,
} from "./store/search.js";

// --- Embeddings (reindex + generateEmbeddings) ---
export {
  reindexCollection,
  generateEmbeddings,
} from "./store/embeddings.js";
export type {
  ReindexProgress,
  ReindexResult,
  EmbedProgress,
  EmbedResult,
  EmbedOptions,
} from "./store/embeddings.js";

// --- Factory ---
export { createStore } from "./store/factory.js";
