// =============================================================================
// Reindex & Embed -- pure-logic functions for SDK and CLI
// =============================================================================

import { readFileSync, statSync } from "node:fs";
import fastGlob from "fast-glob";
import type { Database } from "../db.js";
import {
  LlamaCpp,
  getDefaultLlamaCpp,
  formatDocForEmbedding,
  withLLMSessionForLlm,
} from "../llm.js";
import { getRemoteConfig, getRemoteLLM } from "../remote-config.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_MAX_DOCS_PER_BATCH, DEFAULT_EMBED_MAX_BATCH_BYTES } from "./constants.js";
import { getRealPath, resolve } from "./path.js";
import { extractTitle, hashContent, handelize, insertContent, insertDocument, findActiveDocument, updateDocumentTitle, updateDocument, deactivateDocument, getActiveDocumentPaths } from "./documents.js";
import { cleanupOrphanedContent } from "./maintenance.js";
import { clearAllEmbeddings, insertEmbedding } from "./search.js";
import { chunkDocumentByTokens } from "./chunking.js";
import type { Store, ChunkStrategy } from "./types.js";

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};

export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
};

/**
 * Re-index a single collection by scanning the filesystem and updating the database.
 */
export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(options?.ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    const path = handelize(relativeFile);
    seenPaths.add(path);

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    const existing = findActiveDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        insertContent(db, hash, content, now);
        const stat = statSync(filepath);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      indexed++;
      insertContent(db, hash, content, now);
      const stat = statSync(filepath);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
    }

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  // Deactivate documents that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, unchanged, removed, orphanedCleaned };
}

export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  errors: number;
};

export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
};

export type EmbedOptions = {
  force?: boolean;
  model?: string;
  maxDocsPerBatch?: number;
  maxBatchBytes?: number;
  chunkStrategy?: ChunkStrategy;
  onProgress?: (info: EmbedProgress) => void;
};

type PendingEmbeddingDoc = {
  hash: string;
  path: string;
  bytes: number;
};

type EmbeddingDoc = PendingEmbeddingDoc & {
  body: string;
};

type ChunkItem = {
  hash: string;
  title: string;
  text: string;
  seq: number;
  pos: number;
  tokens: number;
  bytes: number;
};

function validatePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveEmbedOptions(options?: EmbedOptions): Required<Pick<EmbedOptions, "maxDocsPerBatch" | "maxBatchBytes">> {
  return {
    maxDocsPerBatch: validatePositiveIntegerOption("maxDocsPerBatch", options?.maxDocsPerBatch, DEFAULT_EMBED_MAX_DOCS_PER_BATCH),
    maxBatchBytes: validatePositiveIntegerOption("maxBatchBytes", options?.maxBatchBytes, DEFAULT_EMBED_MAX_BATCH_BYTES),
  };
}

function getPendingEmbeddingDocs(db: Database): PendingEmbeddingDoc[] {
  return db.prepare(`
    SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
    ORDER BY MIN(d.path)
  `).all() as PendingEmbeddingDoc[];
}

function buildEmbeddingBatches(
  docs: PendingEmbeddingDoc[],
  maxDocsPerBatch: number,
  maxBatchBytes: number,
): PendingEmbeddingDoc[][] {
  const batches: PendingEmbeddingDoc[][] = [];
  let currentBatch: PendingEmbeddingDoc[] = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Math.max(0, doc.bytes);
    const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
    const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;

    if (wouldExceedDocs || wouldExceedBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(doc);
    currentBytes += docBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function getEmbeddingDocsForBatch(db: Database, batch: PendingEmbeddingDoc[]): EmbeddingDoc[] {
  if (batch.length === 0) return [];

  const placeholders = batch.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT hash, doc as body
    FROM content
    WHERE hash IN (${placeholders})
  `).all(...batch.map(doc => doc.hash)) as { hash: string; body: string }[];
  const bodyByHash = new Map(rows.map(row => [row.hash, row.body]));

  return batch.map((doc) => ({
    ...doc,
    body: bodyByHash.get(doc.hash) ?? "",
  }));
}

/**
 * Generate vector embeddings for documents that need them.
 */
export async function generateEmbeddings(
  store: Store,
  options?: EmbedOptions
): Promise<EmbedResult> {
  const db = store.db;
  const model = options?.model ?? DEFAULT_EMBED_MODEL;
  const now = new Date().toISOString();
  const { maxDocsPerBatch, maxBatchBytes } = resolveEmbedOptions(options);
  const encoder = new TextEncoder();

  if (options?.force) {
    clearAllEmbeddings(db);
  }

  const docsToEmbed = getPendingEmbeddingDocs(db);

  if (docsToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }
  const totalBytes = docsToEmbed.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);
  const totalDocs = docsToEmbed.length;
  const startTime = Date.now();

  // Remote embedding takes priority when configured
  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.embed) {
    const remote = getRemoteLLM()!;
    const BATCH_SIZE = 32;
    let chunksEmbedded = 0;
    let errors = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let vectorTableInitialized = false;
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;
        const title = extractTitle(doc.body, doc.path);
        const chunks = await chunkDocumentByTokens(
          doc.body, undefined, undefined, undefined, doc.path,
          options?.chunkStrategy,
        );
        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash, title, text: chunks[seq]!.text, seq,
            pos: chunks[seq]!.pos, tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
          });
        }
      }

      totalChunks += batchChunks.length;
      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
        continue;
      }

      if (!vectorTableInitialized) {
        try {
          const firstResult = await remote.embed(batchChunks[0]!.text);
          if (!firstResult) throw new Error("Remote embedding returned null for first chunk");
          store.ensureVecTable(firstResult.embedding.length);
          vectorTableInitialized = true;
        } catch (err) {
          throw new Error(`Failed to initialize vector table via remote embed: ${err instanceof Error ? err.message : err}`);
        }
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => chunk.text);

        try {
          const embeddings = await remote.embedBatch(texts);
          for (let i = 0; i < chunkBatch.length; i++) {
            const chunk = chunkBatch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
            batchChunkBytesProcessed += chunk.bytes;
          }
        } catch (err) {
          process.stderr.write(`Remote embedBatch error at offset ${batchStart}: ${err instanceof Error ? err.message : err}\n`);
          errors += chunkBatch.length;
          batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed: bytesProcessed + proportionalBytes, totalBytes, errors });
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
    }

    return { docsProcessed: totalDocs, chunksEmbedded, errors, durationMs: Date.now() - startTime };
  }

  // Local path: use store's LlamaCpp or global singleton, wrapped in a session
  const llm = store.llm ?? getDefaultLlamaCpp();
  const embedModelUri = llm.embedModelName;

  const result = await withLLMSessionForLlm(llm, async (session) => {
    let chunksEmbedded = 0;
    let errors = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let vectorTableInitialized = false;
    const BATCH_SIZE = 32;
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      if (!session.isValid) {
        console.warn(`\u26a0 Session expired -- skipping remaining document batches`);
        break;
      }

      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;

        const title = extractTitle(doc.body, doc.path);
        const chunks = await chunkDocumentByTokens(
          doc.body,
          undefined, undefined, undefined,
          doc.path,
          options?.chunkStrategy,
          session.signal,
        );

        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash,
            title,
            text: chunks[seq]!.text,
            seq,
            pos: chunks[seq]!.pos,
            tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
          });
        }
      }

      totalChunks += batchChunks.length;

      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
        continue;
      }

      if (!vectorTableInitialized) {
        const firstChunk = batchChunks[0]!;
        const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title, embedModelUri);
        const firstResult = await session.embed(firstText, { model });
        if (!firstResult) {
          throw new Error("Failed to get embedding dimensions from first chunk");
        }
        store.ensureVecTable(firstResult.embedding.length);
        vectorTableInitialized = true;
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        if (!session.isValid) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`\u26a0 Session expired -- skipping ${remaining} remaining chunks`);
          break;
        }

        const processed = chunksEmbedded + errors;
        if (processed >= BATCH_SIZE && errors > processed * 0.8) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`\u26a0 Error rate too high (${errors}/${processed}) -- aborting embedding`);
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title, embedModelUri));

        try {
          const embeddings = await session.embedBatch(texts, { model });
          for (let i = 0; i < chunkBatch.length; i++) {
            const chunk = chunkBatch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
            batchChunkBytesProcessed += chunk.bytes;
          }
        } catch {
          if (!session.isValid) {
            errors += chunkBatch.length;
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else {
            for (const chunk of chunkBatch) {
              try {
                const text = formatDocForEmbedding(chunk.text, chunk.title, embedModelUri);
                const result = await session.embed(text, { model });
                if (result) {
                  insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now);
                  chunksEmbedded++;
                } else {
                  errors++;
                }
              } catch {
                errors++;
              }
              batchChunkBytesProcessed += chunk.bytes;
            }
          }
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({
          chunksEmbedded,
          totalChunks,
          bytesProcessed: bytesProcessed + proportionalBytes,
          totalBytes,
          errors,
        });
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
    }

    return { chunksEmbedded, errors };
  }, { maxDuration: 30 * 60 * 1000, name: 'generateEmbeddings' });

  return {
    docsProcessed: totalDocs,
    chunksEmbedded: result.chunksEmbedded,
    errors: result.errors,
    durationMs: Date.now() - startTime,
  };
}
