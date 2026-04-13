// =============================================================================
// Search pipeline: FTS, vector, RRF, boosts, snippets, hybrid/structured
// =============================================================================

import type { Database } from "../db.js";
import type { LLM, RerankDocument, ILLMSession } from "../llm.js";
import {
  formatQueryForEmbedding,
  formatDocForEmbedding,
  createTransformersEmbedBackend,
} from "../llm.js";
import { getRemoteConfig, getRemoteLLM } from "../remote-config.js";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_QUERY_MODEL,
  STRONG_SIGNAL_MIN_SCORE,
  STRONG_SIGNAL_MIN_GAP,
  RERANK_CANDIDATE_LIMIT,
  RRF_K,
  WEIGHT_FTS,
  WEIGHT_VEC,
  BLEND_RRF_TOP3,
  BLEND_RRF_TOP10,
  BLEND_RRF_REST,
  CHUNK_SIZE_CHARS,
  INTENT_WEIGHT_SNIPPET,
  INTENT_WEIGHT_CHUNK,
  extractIntentTerms,
} from "./constants.js";
import { getContextForFile } from "./context.js";
import { getDocid } from "./documents.js";
import { getCacheKey, getCachedResult, setCachedResult } from "./maintenance.js";
import { chunkDocumentAsync } from "./chunking.js";
import type {
  Store,
  SearchResult,
  RankedResult,
  RRFContributionTrace,
  RRFScoreTrace,
  HybridQueryExplain,
  ExpandedQuery,
  SnippetResult,
  RankedListMeta,
  ChunkStrategy,
} from "./types.js";

// =============================================================================
// Zero-LLM search boosts (applied after RRF, before reranking)
// =============================================================================

const BOOST_STOP_WORDS = new Set([
  "what", "when", "where", "who", "how", "which", "did", "do",
  "was", "were", "have", "has", "had", "is", "are", "the", "a",
  "an", "my", "me", "i", "you", "your", "their", "it", "its",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "ago", "last", "that", "this", "there", "about", "get", "got",
  "give", "gave", "buy", "bought", "made", "make", "can", "could",
  "would", "should", "will", "shall", "may", "might", "been",
]);

/** Boost when query keywords appear verbatim in result text (+1.2% recall) */
function keywordOverlapBoost(query: string, text: string): number {
  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !BOOST_STOP_WORDS.has(w)));
  if (queryWords.size === 0) return 1.0;
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const word of queryWords) {
    if (textLower.includes(word)) hits++;
  }
  return 1 + 0.3 * (hits / queryWords.size);
}

/** Boost when query contains "exact phrases" found in result text (+0.6% recall) */
function quotedPhraseBoost(query: string, text: string): number {
  const phrases = [...query.matchAll(/["']([^"']{3,})["']/g)].map(m => m[1]!.toLowerCase());
  if (phrases.length === 0) return 1.0;
  const textLower = text.toLowerCase();
  for (const phrase of phrases) {
    if (textLower.includes(phrase)) return 1.6;
  }
  return 1.0;
}

/** Boost when query contains proper nouns found in result text (+0.6% recall) */
function personNameBoost(query: string, text: string): number {
  const names = query.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  if (names.length === 0) return 1.0;
  const textLower = text.toLowerCase();
  for (const name of names) {
    if (textLower.includes(name.toLowerCase())) return 1.4;
  }
  return 1.0;
}

/** Apply all zero-LLM boosts to a result */
function applySearchBoosts(query: string, text: string, score: number): number {
  let boost = 1.0;
  boost *= keywordOverlapBoost(query, text);
  if (query.includes('"') || query.includes("'")) boost *= quotedPhraseBoost(query, text);
  if (/[A-Z][a-z]{2,}/.test(query)) boost *= personNameBoost(query, text);
  return score * boost;
}

// =============================================================================
// FTS Search
// =============================================================================

export function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase();
}

function isHyphenatedToken(token: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}'-]*-[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(token);
}

function sanitizeHyphenatedTerm(term: string): string {
  return term.split('-').map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
}

function buildFTS5Query(query: string): string | null {
  const positive: string[] = [];
  const negative: string[] = [];

  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    const negated = s[i] === '-';
    if (negated) i++;

    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++; // skip closing quote
      if (phrase.length > 0) {
        const sanitized = phrase.split(/\s+/).map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      }
    } else {
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);

      if (isHyphenatedToken(term)) {
        const sanitized = sanitizeHyphenatedTerm(term);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      } else {
        const sanitized = sanitizeFTS5Term(term);
        if (sanitized) {
          const ftsTerm = `"${sanitized}"*`;
          if (negated) {
            negative.push(ftsTerm);
          } else {
            positive.push(ftsTerm);
          }
        }
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null;
  if (positive.length === 0) return null;

  let result = positive.join(' AND ');

  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }

  return result;
}

export function validateSemanticQuery(query: string): string | null {
  if (/-\w/.test(query) || /-"/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}

export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
}

export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  const params: (string | number)[] = [ftsQuery];
  const ftsLimit = collectionName ? limit * 10 : limit;

  let sql = `
    WITH fts_matches AS (
      SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
      FROM documents_fts
      WHERE documents_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ${ftsLimit}
    )
    SELECT
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body,
      d.hash,
      fm.bm25_score
    FROM fts_matches fm
    JOIN documents d ON d.id = fm.rowid
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `;

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(String(collectionName));
  }

  sql += ` ORDER BY fm.bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { filepath: string; display_path: string; title: string; body: string; hash: string; bm25_score: number }[];
  return rows.map(row => {
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName,
      modifiedAt: "",
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score,
      source: "fts" as const,
    };
  });
}

// =============================================================================
// Vector Search
// =============================================================================

export async function searchVec(db: Database, query: string, model: string, limit: number = 20, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]): Promise<SearchResult[]> {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return [];

  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session);
  if (!embedding) return [];

  // Step 1: Get vector matches from sqlite-vec (no JOINs allowed)
  const vecResults = db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];

  if (vecResults.length === 0) return [];

  // Step 2: Get chunk info and document data
  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (collectionName) {
    docSql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body: string;
  }[];

  // Combine with distances and dedupe by filepath
  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName,
        modifiedAt: "",
        bodyLength: row.body.length,
        body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist,
        source: "vec" as const,
        chunkPos: row.pos,
      };
    });
}

// =============================================================================
// Embeddings helpers
// =============================================================================

// Cached singleton of the local transformers embed backend. Opt-in only
// via QMD_EMBED_BACKEND=transformers — the native onnxruntime-node binding
// it pulls in (plus sharp) can crash on Windows test envs, and callers that
// only use remote embed should not pay the load cost.
let _localEmbed: any = null;
async function getLocalEmbedBackend(): Promise<any> {
  if (process.env.QMD_EMBED_BACKEND !== "transformers") return null;
  if (_localEmbed) return _localEmbed;
  try {
    _localEmbed = await createTransformersEmbedBackend();
    return _localEmbed;
  } catch (err) {
    process.stderr.write(`local embed backend load failed: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession, llmOverride?: LLM): Promise<number[] | null> {
  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.embed) {
    try {
      const remote = getRemoteLLM()!;
      const result = await remote.embed(text, { isQuery });
      return result?.embedding || null;
    } catch (err) {
      process.stderr.write(`Remote embed failed, falling back to local: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  if (session) {
    const result = await session.embed(formattedText, { model, isQuery });
    return result?.embedding || null;
  }
  if (llmOverride) {
    const result = await llmOverride.embed(formattedText, { model, isQuery });
    return result?.embedding || null;
  }
  const local = await getLocalEmbedBackend();
  if (!local) return null;
  const result = await local.embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}

export function getHashesForEmbedding(db: Database): { hash: string; body: string; path: string }[] {
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}

export function clearAllEmbeddings(db: Database): void {
  db.exec(`DELETE FROM content_vectors`);
  db.exec(`DROP TABLE IF EXISTS vectors_vec`);
}

export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string
): void {
  const hashSeq = `${hash}_${seq}`;

  const insertContentVectorStmt = db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`);
  insertContentVectorStmt.run(hash, seq, pos, model, embeddedAt);

  const deleteVecStmt = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
  const insertVecStmt = db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
  deleteVecStmt.run(hashSeq);
  insertVecStmt.run(hashSeq, embedding);
}

// =============================================================================
// Query expansion
// =============================================================================

export async function expandQuery(query: string, model: string = DEFAULT_QUERY_MODEL, db: Database, intent?: string, llmOverride?: LLM): Promise<ExpandedQuery[]> {
  const cacheKey = getCacheKey("expandQuery", { query, model, ...(intent && { intent }) });
  const cached = getCachedResult(db, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as any[];
      if (parsed.length > 0 && parsed[0].query) {
        return parsed as ExpandedQuery[];
      } else if (parsed.length > 0 && parsed[0].text) {
        return parsed.map((r: any) => ({ type: r.type, query: r.text }));
      }
    } catch {
      // Old cache format -- re-expand
    }
  }

  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.queryExpansion) {
    try {
      const remote = getRemoteLLM()!;
      const results = await remote.expandQuery(query, { includeLexical: true, context: intent });
      const expanded: ExpandedQuery[] = results
        .filter(r => r.text !== query)
        .map(r => ({ type: r.type, query: r.text }));
      if (expanded.length > 0) {
        setCachedResult(db, cacheKey, JSON.stringify(expanded));
      }
      return expanded;
    } catch (err) {
      process.stderr.write(`Remote query expansion failed, falling back to local: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // No remote query expansion configured, no local backend for expansion
  // (transformers.js does not do generation). Skip — caller falls back to
  // the raw query, which is the same behaviour as a one-shot non-expanded run.
  if (llmOverride) {
    try {
      const results = await llmOverride.expandQuery(query, { context: intent });
      const expanded: ExpandedQuery[] = results
        .filter(r => r.text !== query)
        .map(r => ({ type: r.type, query: r.text }));
      if (expanded.length > 0) {
        setCachedResult(db, cacheKey, JSON.stringify(expanded));
      }
      return expanded;
    } catch {
      // fall through
    }
  }
  return [];
}

// =============================================================================
// Reranking
// =============================================================================

export async function rerank(query: string, documents: { file: string; text: string }[], model?: string, db?: Database, intent?: string, llmOverride?: LLM): Promise<{ file: string; score: number }[]> {
  const rerankQuery = intent ? `${intent}\n\n${query}` : query;
  const effectiveModel = model ?? DEFAULT_RERANK_MODEL;

  const remoteConfig = getRemoteConfig();
  if (remoteConfig?.rerank) {
    try {
      const remote = getRemoteLLM()!;
      const rerankDocs = documents.map(d => ({ file: d.file, text: d.text }));
      const result = await remote.rerank(rerankQuery, rerankDocs, {});
      return result.results
        .map(r => ({ file: r.file, score: r.score }))
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      process.stderr.write(`Remote rerank failed, falling back to local: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  const cachedResults: Map<string, number> = new Map();
  const uncachedDocsByChunk: Map<string, RerankDocument> = new Map();

  if (db) {
    for (const doc of documents) {
      const cacheKey = getCacheKey("rerank", { query: rerankQuery, model: effectiveModel, chunk: doc.text });
      const legacyCacheKey = getCacheKey("rerank", { query, file: doc.file, model: effectiveModel, chunk: doc.text });
      const cached = getCachedResult(db, cacheKey) ?? getCachedResult(db, legacyCacheKey);
      if (cached !== null) {
        cachedResults.set(doc.text, parseFloat(cached));
      } else {
        uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
      }
    }
  } else {
    for (const doc of documents) {
      uncachedDocsByChunk.set(doc.text, { file: doc.file, text: doc.text });
    }
  }

  if (uncachedDocsByChunk.size > 0 && llmOverride) {
    const uncachedDocs = [...uncachedDocsByChunk.values()];
    try {
      const rerankResult = await llmOverride.rerank(rerankQuery, uncachedDocs, { model: effectiveModel });
      if (db) {
        const textByFile = new Map(uncachedDocs.map(d => [d.file, d.text]));
        for (const result of rerankResult.results) {
          const chunk = textByFile.get(result.file) || "";
          const cacheKey = getCacheKey("rerank", { query: rerankQuery, model: effectiveModel, chunk });
          setCachedResult(db, cacheKey, result.score.toString());
          cachedResults.set(chunk, result.score);
        }
      } else {
        for (const result of rerankResult.results) {
          cachedResults.set(result.file, result.score);
        }
      }
    } catch (err) {
      process.stderr.write(`llmOverride rerank failed: ${err instanceof Error ? err.message : err}\n`);
    }
  }
  // If no remote rerank and no llmOverride, the uncached docs simply get a
  // score of 0 and fall to the bottom of the list — but the cached/already-
  // ranked docs (from FTS+vector RRF) still come through, so search continues
  // to work. This is the post-cleanup graceful-degradation path.

  return documents
    .map(doc => ({ file: doc.file, score: cachedResults.get(doc.text) || 0 }))
    .sort((a, b) => b.score - a.score);
}

// =============================================================================
// Reciprocal Rank Fusion
// =============================================================================

export function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],
  k: number = RRF_K
): RankedResult[] {
  const scores = new Map<string, { result: RankedResult; rrfScore: number; topRank: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      if (!result) continue;
      const rrfContribution = weight / (k + rank + 1);
      const existing = scores.get(result.file);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.topRank = Math.min(existing.topRank, rank);
      } else {
        scores.set(result.file, {
          result,
          rrfScore: rrfContribution,
          topRank: rank,
        });
      }
    }
  }

  // Top-rank bonus
  for (const entry of scores.values()) {
    if (entry.topRank === 0) {
      entry.rrfScore += 0.05;
    } else if (entry.topRank <= 2) {
      entry.rrfScore += 0.02;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(e => ({ ...e.result, score: e.rrfScore }));
}

export function buildRrfTrace(
  resultLists: RankedResult[][],
  weights: number[] = [],
  listMeta: RankedListMeta[] = [],
  k: number = RRF_K
): Map<string, RRFScoreTrace> {
  const traces = new Map<string, RRFScoreTrace>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const list = resultLists[listIdx];
    if (!list) continue;
    const weight = weights[listIdx] ?? 1.0;
    const meta = listMeta[listIdx] ?? {
      source: "fts",
      queryType: "original",
      query: "",
    } as const;

    for (let rank0 = 0; rank0 < list.length; rank0++) {
      const result = list[rank0];
      if (!result) continue;
      const rank = rank0 + 1;
      const contribution = weight / (k + rank);
      const existing = traces.get(result.file);

      const detail: RRFContributionTrace = {
        listIndex: listIdx,
        source: meta.source,
        queryType: meta.queryType,
        query: meta.query,
        rank,
        weight,
        backendScore: result.score,
        rrfContribution: contribution,
      };

      if (existing) {
        existing.baseScore += contribution;
        existing.topRank = Math.min(existing.topRank, rank);
        existing.contributions.push(detail);
      } else {
        traces.set(result.file, {
          contributions: [detail],
          baseScore: contribution,
          topRank: rank,
          topRankBonus: 0,
          totalScore: 0,
        });
      }
    }
  }

  for (const trace of traces.values()) {
    let bonus = 0;
    if (trace.topRank === 1) bonus = 0.05;
    else if (trace.topRank <= 3) bonus = 0.02;
    trace.topRankBonus = bonus;
    trace.totalScore = trace.baseScore + bonus;
  }

  return traces;
}

// =============================================================================
// Snippet extraction
// =============================================================================

export function extractSnippet(body: string, query: string, maxLen = 500, chunkPos?: number, chunkLen?: number, intent?: string): SnippetResult {
  const totalLines = body.split('\n').length;
  let searchBody = body;
  let lineOffset = 0;

  if (chunkPos && chunkPos > 0) {
    const searchLen = chunkLen || CHUNK_SIZE_CHARS;
    const contextStart = Math.max(0, chunkPos - 100);
    const contextEnd = Math.min(body.length, chunkPos + searchLen + 100);
    searchBody = body.slice(contextStart, contextEnd);
    if (contextStart > 0) {
      lineOffset = body.slice(0, contextStart).split('\n').length - 1;
    }
  }

  const lines = searchBody.split('\n');
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  let bestLine = 0, bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lineLower.includes(term)) score += 1.0;
    }
    for (const term of intentTerms) {
      if (lineLower.includes(term)) score += INTENT_WEIGHT_SNIPPET;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  const start = Math.max(0, bestLine - 1);
  const end = Math.min(lines.length, bestLine + 3);
  const snippetLines = lines.slice(start, end);
  let snippetText = snippetLines.join('\n');

  if (chunkPos && chunkPos > 0 && snippetText.trim().length === 0) {
    return extractSnippet(body, query, maxLen, undefined, undefined, intent);
  }

  if (snippetText.length > maxLen) snippetText = snippetText.substring(0, maxLen - 3) + "...";

  const absoluteStart = lineOffset + start + 1;
  const snippetLineCount = snippetLines.length;
  const linesBefore = absoluteStart - 1;
  const linesAfter = totalLines - (absoluteStart + snippetLineCount - 1);

  const header = `@@ -${absoluteStart},${snippetLineCount} @@ (${linesBefore} before, ${linesAfter} after)`;
  const snippet = `${header}\n${snippetText}`;

  return {
    line: lineOffset + bestLine + 1,
    snippet,
    linesBefore,
    linesAfter,
    snippetLines: snippetLineCount,
  };
}

// =============================================================================
// Shared helpers
// =============================================================================

export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

// =============================================================================
// Search orchestration types
// =============================================================================

export interface SearchHooks {
  onStrongSignal?: (topScore: number) => void;
  onExpandStart?: () => void;
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  onEmbedStart?: (count: number) => void;
  onEmbedDone?: (elapsedMs: number) => void;
  onRerankStart?: (chunkCount: number) => void;
  onRerankDone?: (elapsedMs: number) => void;
}

export interface HybridQueryOptions {
  collection?: string;
  limit?: number;
  minScore?: number;
  candidateLimit?: number;
  explain?: boolean;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: ChunkStrategy;
  hooks?: SearchHooks;
}

export interface HybridQueryResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  context: string | null;
  docid: string;
  explain?: HybridQueryExplain;
}

export interface VectorSearchOptions {
  collection?: string;
  limit?: number;
  minScore?: number;
  intent?: string;
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
}

export interface StructuredSearchOptions {
  collections?: string[];
  limit?: number;
  minScore?: number;
  candidateLimit?: number;
  explain?: boolean;
  intent?: string;
  skipRerank?: boolean;
  chunkStrategy?: ChunkStrategy;
  hooks?: SearchHooks;
}

/**
 * Get the LLM instance for a store, if any. Post-cleanup this is typically a
 * RemoteLLM (cloud rerank/generate) or a TransformersEmbedBackend (local embed).
 * May return null — callers must handle no-LLM gracefully (skip rerank/expand).
 */
function getLlm(store: Store): LLM | null {
  return store.llm ?? null;
}

// =============================================================================
// hybridQuery
// =============================================================================

export async function hybridQuery(
  store: Store,
  query: string,
  options?: HybridQueryOptions
): Promise<HybridQueryResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const collection = options?.collection;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>();
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  // Step 1: BM25 probe
  const initialFts = store.searchFTS(query, 20, collection);
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  const hasStrongSignal = !intent && initialFts.length > 0
    && topScore >= STRONG_SIGNAL_MIN_SCORE
    && (topScore - secondScore) >= STRONG_SIGNAL_MIN_GAP;

  if (hasStrongSignal) hooks?.onStrongSignal?.(topScore);

  // Step 2: Expand query
  hooks?.onExpandStart?.();
  const expandStart = Date.now();
  const expanded = hasStrongSignal
    ? []
    : await store.expandQuery(query, undefined, intent);

  hooks?.onExpand?.(query, expanded, Date.now() - expandStart);

  // Seed with initial FTS results
  if (initialFts.length > 0) {
    for (const r of initialFts) docidMap.set(r.filepath, r.docid);
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
    rankedListMeta.push({ source: "fts", queryType: "original", query });
  }

  // Step 3: Route searches by query type
  // 3a: FTS for lex expansions
  for (const q of expanded) {
    if (q.type === 'lex') {
      const ftsResults = store.searchFTS(q.query, 20, collection);
      if (ftsResults.length > 0) {
        for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(ftsResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({ source: "fts", queryType: "lex", query: q.query });
      }
    }
  }

  // 3b: Vector queries
  if (hasVectors) {
    const vecQueries: { text: string; queryType: "original" | "vec" | "hyde" }[] = [
      { text: query, queryType: "original" },
    ];
    for (const q of expanded) {
      if (q.type === 'vec' || q.type === 'hyde') {
        vecQueries.push({ text: q.query, queryType: q.type });
      }
    }

    hooks?.onEmbedStart?.(vecQueries.length);
    const embedStart = Date.now();
    const remoteConfigHQ = getRemoteConfig();
    let embeddings: ({ embedding: number[] } | null)[];
    if (remoteConfigHQ?.embed) {
      const remote = getRemoteLLM()!;
      const textsToEmbed = vecQueries.map(q => q.text);
      embeddings = await remote.embedBatch(textsToEmbed);
    } else {
      // Local path: use store-provided LLM if any, otherwise lazy-load
      // the default transformers embed backend.
      const localLlm = getLlm(store) ?? (await getLocalEmbedBackend());
      if (!localLlm) {
        embeddings = vecQueries.map(() => null);
      } else {
        const modelName = (localLlm as any).embedModelName ?? "local";
        const textsToEmbed = vecQueries.map(q => formatQueryForEmbedding(q.text, modelName));
        embeddings = await localLlm.embedBatch(textsToEmbed);
      }
    }
    hooks?.onEmbedDone?.(Date.now() - embedStart);

    for (let i = 0; i < vecQueries.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) continue;

      const vecResults = await store.searchVec(
        vecQueries[i]!.text, DEFAULT_EMBED_MODEL, 20, collection,
        undefined, embedding
      );
      if (vecResults.length > 0) {
        for (const r of vecResults) docidMap.set(r.filepath, r.docid);
        rankedLists.push(vecResults.map(r => ({
          file: r.filepath, displayPath: r.displayPath,
          title: r.title, body: r.body || "", score: r.score,
        })));
        rankedListMeta.push({
          source: "vec",
          queryType: vecQueries[i]!.queryType,
          query: vecQueries[i]!.text,
        });
      }
    }
  }

  // Step 4: RRF fusion
  const weights = rankedLists.map((_, i) => i < 2 ? WEIGHT_FTS : WEIGHT_VEC);
  const fused = reciprocalRankFusion(rankedLists, weights);

  // Step 4b: Zero-LLM boosts
  for (const result of fused) {
    result.score = applySearchBoosts(query, result.body, result.score);
  }
  fused.sort((a, b) => b.score - a.score);

  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  // Step 5: Chunk documents, pick best chunk per doc
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = new Map<string, { chunks: { text: string; pos: number }[]; bestIdx: number }>();

  const chunkStrategy = options?.chunkStrategy;
  for (const cand of candidates) {
    const chunks = await chunkDocumentAsync(cand.body, undefined, undefined, undefined, cand.file, chunkStrategy);
    if (chunks.length === 0) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunkLower = chunks[i]!.text.toLowerCase();
      let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
      for (const term of intentTerms) {
        if (chunkLower.includes(term)) score += INTENT_WEIGHT_CHUNK;
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    docChunkMap.set(cand.file, { chunks, bestIdx });
  }

  if (skipRerank) {
    const seenFiles = new Set<string>();
    return candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const bestIdx = chunkInfo?.bestIdx ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || cand.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: cand.displayPath,
          title: cand.title,
          body: cand.body,
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: store.getContextForFile(cand.file),
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // Step 6: Rerank chunks
  const chunksToRerank: { file: string; text: string }[] = [];
  for (const cand of candidates) {
    const chunkInfo = docChunkMap.get(cand.file);
    if (chunkInfo) {
      chunksToRerank.push({ file: cand.file, text: chunkInfo.chunks[chunkInfo.bestIdx]!.text });
    }
  }

  hooks?.onRerankStart?.(chunksToRerank.length);
  const rerankStart = Date.now();
  const reranked = await store.rerank(query, chunksToRerank, undefined, intent);
  hooks?.onRerankDone?.(Date.now() - rerankStart);

  // Step 7: Blend RRF position score with reranker score
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = BLEND_RRF_TOP3;
    else if (rrfRank <= 10) rrfWeight = BLEND_RRF_TOP10;
    else rrfWeight = BLEND_RRF_REST;
    const rrfScore = 1 / rrfRank;
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: store.getContextForFile(r.file),
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 8: Dedup by file
  const seenFiles = new Set<string>();
  return blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

// =============================================================================
// vectorSearchQuery
// =============================================================================

export async function vectorSearchQuery(
  store: Store,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;
  const intent = options?.intent;

  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();
  if (!hasVectors) return [];

  const expandStart = Date.now();
  const allExpanded = await store.expandQuery(query, undefined, intent);
  const vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  const queryTexts = [query, ...vecExpanded.map(q => q.query)];
  const allResults = new Map<string, VectorSearchResult>();
  for (const q of queryTexts) {
    const vecResults = await store.searchVec(q, DEFAULT_EMBED_MODEL, limit, collection);
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
          context: store.getContextForFile(r.filepath),
          docid: r.docid,
        });
      }
    }
  }

  return Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}

// =============================================================================
// structuredSearch
// =============================================================================

export async function structuredSearch(
  store: Store,
  searches: ExpandedQuery[],
  options?: StructuredSearchOptions
): Promise<HybridQueryResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0;
  const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;
  const explain = options?.explain ?? false;
  const intent = options?.intent;
  const skipRerank = options?.skipRerank ?? false;
  const hooks = options?.hooks;

  const collections = options?.collections;

  if (searches.length === 0) return [];

  // Validate queries
  for (const search of searches) {
    const location = search.line ? `Line ${search.line}` : 'Structured search';
    if (/[\r\n]/.test(search.query)) {
      throw new Error(`${location} (${search.type}): queries must be single-line. Remove newline characters.`);
    }
    if (search.type === 'lex') {
      const error = validateLexQuery(search.query);
      if (error) {
        throw new Error(`${location} (lex): ${error}`);
      }
    } else if (search.type === 'vec' || search.type === 'hyde') {
      const error = validateSemanticQuery(search.query);
      if (error) {
        throw new Error(`${location} (${search.type}): ${error}`);
      }
    }
  }

  const rankedLists: RankedResult[][] = [];
  const rankedListMeta: RankedListMeta[] = [];
  const docidMap = new Map<string, string>();
  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();

  const collectionList = collections ?? [undefined];

  // Step 1: FTS for lex searches
  for (const search of searches) {
    if (search.type === 'lex') {
      for (const coll of collectionList) {
        const ftsResults = store.searchFTS(search.query, 20, coll);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) docidMap.set(r.filepath, r.docid);
          rankedLists.push(ftsResults.map(r => ({
            file: r.filepath, displayPath: r.displayPath,
            title: r.title, body: r.body || "", score: r.score,
          })));
          rankedListMeta.push({
            source: "fts",
            queryType: "lex",
            query: search.query,
          });
        }
      }
    }
  }

  // Step 2: Batch embed and run vector searches
  if (hasVectors) {
    const vecSearches = searches.filter(
      (s): s is ExpandedQuery & { type: 'vec' | 'hyde' } =>
        s.type === 'vec' || s.type === 'hyde'
    );
    if (vecSearches.length > 0) {
      hooks?.onEmbedStart?.(vecSearches.length);
      const embedStart = Date.now();
      const remoteConfigSS = getRemoteConfig();
      let embeddings: ({ embedding: number[] } | null)[];
      if (remoteConfigSS?.embed) {
        const remote = getRemoteLLM()!;
        const textsToEmbed = vecSearches.map(s => s.query);
        embeddings = await remote.embedBatch(textsToEmbed);
      } else {
        const localLlm = getLlm(store) ?? (await getLocalEmbedBackend());
        if (!localLlm) {
          embeddings = vecSearches.map(() => null);
        } else {
          const modelName = (localLlm as any).embedModelName ?? "local";
          const textsToEmbed = vecSearches.map(s => formatQueryForEmbedding(s.query, modelName));
          embeddings = await localLlm.embedBatch(textsToEmbed);
        }
      }
      hooks?.onEmbedDone?.(Date.now() - embedStart);

      for (let i = 0; i < vecSearches.length; i++) {
        const embedding = embeddings[i]?.embedding;
        if (!embedding) continue;

        for (const coll of collectionList) {
          const vecResults = await store.searchVec(
            vecSearches[i]!.query, DEFAULT_EMBED_MODEL, 20, coll,
            undefined, embedding
          );
          if (vecResults.length > 0) {
            for (const r of vecResults) docidMap.set(r.filepath, r.docid);
            rankedLists.push(vecResults.map(r => ({
              file: r.filepath, displayPath: r.displayPath,
              title: r.title, body: r.body || "", score: r.score,
            })));
            rankedListMeta.push({
              source: "vec",
              queryType: vecSearches[i]!.type,
              query: vecSearches[i]!.query,
            });
          }
        }
      }
    }
  }

  if (rankedLists.length === 0) return [];

  // Step 3: RRF fusion
  const weights = rankedLists.map((_, i) => i === 0 ? WEIGHT_FTS : WEIGHT_VEC);
  const fused = reciprocalRankFusion(rankedLists, weights);

  // Step 3b: Zero-LLM boosts
  const boostQuery = searches[0]?.query || "";
  for (const result of fused) {
    result.score = applySearchBoosts(boostQuery, result.body, result.score);
  }
  fused.sort((a, b) => b.score - a.score);

  const rrfTraceByFile = explain ? buildRrfTrace(rankedLists, weights, rankedListMeta) : null;
  const candidates = fused.slice(0, candidateLimit);

  if (candidates.length === 0) return [];

  hooks?.onExpand?.("", [], 0);

  // Step 4: Chunk documents, pick best chunk
  const primaryQuery = searches.find(s => s.type === 'lex')?.query
    || searches.find(s => s.type === 'vec')?.query
    || searches[0]?.query || "";
  const queryTerms = primaryQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const intentTerms = intent ? extractIntentTerms(intent) : [];
  const docChunkMap = new Map<string, { chunks: { text: string; pos: number }[]; bestIdx: number }>();
  const ssChunkStrategy = options?.chunkStrategy;

  for (const cand of candidates) {
    const chunks = await chunkDocumentAsync(cand.body, undefined, undefined, undefined, cand.file, ssChunkStrategy);
    if (chunks.length === 0) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < chunks.length; i++) {
      const chunkLower = chunks[i]!.text.toLowerCase();
      let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
      for (const term of intentTerms) {
        if (chunkLower.includes(term)) score += INTENT_WEIGHT_CHUNK;
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    docChunkMap.set(cand.file, { chunks, bestIdx });
  }

  if (skipRerank) {
    const seenFiles = new Set<string>();
    return candidates
      .map((cand, i) => {
        const chunkInfo = docChunkMap.get(cand.file);
        const bestIdx = chunkInfo?.bestIdx ?? 0;
        const bestChunk = chunkInfo?.chunks[bestIdx]?.text || cand.body || "";
        const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
        const rrfRank = i + 1;
        const rrfScore = 1 / rrfRank;
        const trace = rrfTraceByFile?.get(cand.file);
        const explainData: HybridQueryExplain | undefined = explain ? {
          ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
          vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
          rrf: {
            rank: rrfRank,
            positionScore: rrfScore,
            weight: 1.0,
            baseScore: trace?.baseScore ?? 0,
            topRankBonus: trace?.topRankBonus ?? 0,
            totalScore: trace?.totalScore ?? 0,
            contributions: trace?.contributions ?? [],
          },
          rerankScore: 0,
          blendedScore: rrfScore,
        } : undefined;

        return {
          file: cand.file,
          displayPath: cand.displayPath,
          title: cand.title,
          body: cand.body,
          bestChunk,
          bestChunkPos,
          score: rrfScore,
          context: store.getContextForFile(cand.file),
          docid: docidMap.get(cand.file) || "",
          ...(explainData ? { explain: explainData } : {}),
        };
      })
      .filter(r => {
        if (seenFiles.has(r.file)) return false;
        seenFiles.add(r.file);
        return true;
      })
      .filter(r => r.score >= minScore)
      .slice(0, limit);
  }

  // Step 5: Rerank chunks
  const chunksToRerank: { file: string; text: string }[] = [];
  for (const cand of candidates) {
    const chunkInfo = docChunkMap.get(cand.file);
    if (chunkInfo) {
      chunksToRerank.push({ file: cand.file, text: chunkInfo.chunks[chunkInfo.bestIdx]!.text });
    }
  }

  hooks?.onRerankStart?.(chunksToRerank.length);
  const rerankStart2 = Date.now();
  const reranked = await store.rerank(primaryQuery, chunksToRerank, undefined, intent);
  hooks?.onRerankDone?.(Date.now() - rerankStart2);

  // Step 6: Blend
  const candidateMap = new Map(candidates.map(c => [c.file, {
    displayPath: c.displayPath, title: c.title, body: c.body,
  }]));
  const rrfRankMap = new Map(candidates.map((c, i) => [c.file, i + 1]));

  const blended = reranked.map(r => {
    const rrfRank = rrfRankMap.get(r.file) || candidateLimit;
    let rrfWeight: number;
    if (rrfRank <= 3) rrfWeight = BLEND_RRF_TOP3;
    else if (rrfRank <= 10) rrfWeight = BLEND_RRF_TOP10;
    else rrfWeight = BLEND_RRF_REST;
    const rrfScore = 1 / rrfRank;
    const blendedScore = rrfWeight * rrfScore + (1 - rrfWeight) * r.score;

    const candidate = candidateMap.get(r.file);
    const chunkInfo = docChunkMap.get(r.file);
    const bestIdx = chunkInfo?.bestIdx ?? 0;
    const bestChunk = chunkInfo?.chunks[bestIdx]?.text || candidate?.body || "";
    const bestChunkPos = chunkInfo?.chunks[bestIdx]?.pos || 0;
    const trace = rrfTraceByFile?.get(r.file);
    const explainData: HybridQueryExplain | undefined = explain ? {
      ftsScores: trace?.contributions.filter(c => c.source === "fts").map(c => c.backendScore) ?? [],
      vectorScores: trace?.contributions.filter(c => c.source === "vec").map(c => c.backendScore) ?? [],
      rrf: {
        rank: rrfRank,
        positionScore: rrfScore,
        weight: rrfWeight,
        baseScore: trace?.baseScore ?? 0,
        topRankBonus: trace?.topRankBonus ?? 0,
        totalScore: trace?.totalScore ?? 0,
        contributions: trace?.contributions ?? [],
      },
      rerankScore: r.score,
      blendedScore,
    } : undefined;

    return {
      file: r.file,
      displayPath: candidate?.displayPath || "",
      title: candidate?.title || "",
      body: candidate?.body || "",
      bestChunk,
      bestChunkPos,
      score: blendedScore,
      context: store.getContextForFile(r.file),
      docid: docidMap.get(r.file) || "",
      ...(explainData ? { explain: explainData } : {}),
    };
  }).sort((a, b) => b.score - a.score);

  // Step 7: Dedup
  const seenFiles = new Set<string>();
  return blended
    .filter(r => {
      if (seenFiles.has(r.file)) return false;
      seenFiles.add(r.file);
      return true;
    })
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}
