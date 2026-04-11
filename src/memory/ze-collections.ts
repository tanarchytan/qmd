/**
 * memory/ze-collections.ts — ZeroEntropy Collections backend for memory search.
 *
 * Stores memories as documents in ZeroEntropy collections.
 * Search uses their hybrid retrieval + optional reranker.
 * EU datacenter first, US fallback.
 *
 * Usage: set QMD_EMBED_PROVIDER=zeroentropy in ~/.config/qmd/.env
 * Collections auto-created per scope (e.g. "qmd-mem-global", "qmd-mem-conv-26").
 */

import ZeroEntropy from "zeroentropy";

// ---------------------------------------------------------------------------
// Client singleton — EU first, US fallback
// ---------------------------------------------------------------------------

let _client: ZeroEntropy | null = null;
let _baseURL: string | null = null;

const EU_BASE = "https://eu-api.zeroentropy.dev/v1";
const US_BASE = "https://api.zeroentropy.dev/v1";

function getApiKey(): string | null {
  if (process.env.QMD_ZE_COLLECTIONS === "off") return null;
  return process.env.QMD_EMBED_API_KEY || process.env.ZEROENTROPY_API_KEY || null;
}

async function getClient(): Promise<ZeroEntropy | null> {
  if (_client) return _client;

  const apiKey = getApiKey();
  if (!apiKey) return null;

  // Try EU first
  try {
    const eu = new ZeroEntropy({ apiKey, baseURL: EU_BASE, maxRetries: 0 });
    await eu.status.getStatus();
    _client = eu;
    _baseURL = EU_BASE;
    return _client;
  } catch {
    // EU failed — try US
  }

  try {
    const us = new ZeroEntropy({ apiKey, baseURL: US_BASE, maxRetries: 1 });
    await us.status.getStatus();
    _client = us;
    _baseURL = US_BASE;
    return _client;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Collection management
// ---------------------------------------------------------------------------

const _ensuredCollections = new Set<string>();

function collectionName(scope: string): string {
  // Sanitize: lowercase, replace non-alnum with dash, max 100 chars
  const clean = scope.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  return `qmd-mem-${clean}`;
}

async function ensureCollection(client: ZeroEntropy, scope: string): Promise<string> {
  const name = collectionName(scope);
  if (_ensuredCollections.has(name)) return name;

  try {
    await client.collections.add({ collection_name: name });
  } catch (e: any) {
    // 409 = already exists, that's fine
    if (e?.status !== 409) throw e;
  }
  _ensuredCollections.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ZeMemoryResult = {
  id: string;       // document path (memory ID)
  text: string;     // snippet content
  score: number;    // relevance score
};

/**
 * Store a memory in ZeroEntropy collection.
 * Called alongside SQLite memoryStore — dual-write.
 */
export async function zeMemoryStore(
  memoryId: string,
  text: string,
  scope: string,
  metadata?: Record<string, string>,
): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;

  try {
    const colName = await ensureCollection(client, scope);
    try {
      await client.documents.add({
        collection_name: colName,
        path: memoryId,
        content: { type: "text", text },
        metadata: metadata || {},
      });
    } catch (addErr: any) {
      // 409 = already exists — delete and re-add
      if (addErr?.status === 409) {
        await client.documents.delete({ collection_name: colName, path: memoryId });
        await client.documents.add({
          collection_name: colName,
          path: memoryId,
          content: { type: "text", text },
          metadata: metadata || {},
        });
      } else {
        throw addErr;
      }
    }
    return true;
  } catch (e) {
    process.stderr.write(`[ze-collections] store failed: ${e instanceof Error ? e.message : e}\n`);
    return false;
  }
}

/**
 * Search memories via ZeroEntropy collection.
 * Uses their hybrid retrieval + zerank-2 reranker.
 * Returns top-k snippets with relevance scores.
 */
export async function zeMemorySearch(
  query: string,
  scope: string,
  limit: number = 10,
  options?: { reranker?: string; latencyMode?: "low" | "high" },
): Promise<ZeMemoryResult[]> {
  const client = await getClient();
  if (!client) return [];

  try {
    const colName = await ensureCollection(client, scope);
    const response = await client.queries.topSnippets({
      collection_name: colName,
      query,
      k: limit,
      reranker: options?.reranker ?? "zerank-2",
      precise_responses: true,  // ~200 char snippets, more precise
    });

    return response.results.map(r => ({
      id: r.path,
      text: r.content,
      score: r.score,
    }));
  } catch (e) {
    process.stderr.write(`[ze-collections] search failed: ${e instanceof Error ? e.message : e}\n`);
    return [];
  }
}

/**
 * Delete a memory from ZeroEntropy collection.
 */
export async function zeMemoryDelete(
  memoryId: string,
  scope: string,
): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;

  try {
    const colName = collectionName(scope);
    await client.documents.delete({
      collection_name: colName,
      path: memoryId,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if ZeroEntropy collections available.
 */
export async function zeIsAvailable(): Promise<boolean> {
  return (await getClient()) !== null;
}

/**
 * Get which datacenter connected.
 */
export function zeDatacenter(): string | null {
  if (!_baseURL) return null;
  return _baseURL.includes("eu-api") ? "EU" : "US";
}
