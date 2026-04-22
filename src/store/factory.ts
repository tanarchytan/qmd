// =============================================================================
// Store Factory
// =============================================================================

import { openDatabase } from "../db.js";
import { getDefaultDbPath, parseVirtualPath, buildVirtualPath, isVirtualPath, resolveVirtualPath, toVirtualPath } from "./path.js";
import { initializeDatabase, ensureVecTableInternal } from "./db-init.js";
import { getHashesNeedingEmbedding, getIndexHealth, getStatus, getCacheKey, getCachedResult, setCachedResult, clearCache, deleteLLMCache, deleteInactiveDocuments, cleanupOrphanedContent, cleanupOrphanedVectors, vacuumDatabase } from "./maintenance.js";
import { getContextForFile, getContextForPath, getCollectionByName, getCollectionsWithoutContext, getTopLevelPathsWithoutContext } from "./context.js";
import { searchFTS, searchVec, expandQuery, rerank, getHashesForEmbedding, clearAllEmbeddings, insertEmbedding } from "./search.js";
import { findDocument, getDocumentBody, findDocuments, findSimilarFiles, matchFilesByGlob, findDocumentByDocid, insertContent, insertDocument, findActiveDocument, updateDocumentTitle, updateDocument, deactivateDocument, getActiveDocumentPaths } from "./documents.js";
import type { Store } from "./types.js";

/**
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/lotl/index.sqlite).
 */
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    // Index health
    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string) => searchFTS(db, query, limit, collectionName),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?, precomputedEmbedding?) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model, db, intent, store.llm),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => rerank(query, documents, model, db, intent, store.llm),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt),
  };

  return store;
}
