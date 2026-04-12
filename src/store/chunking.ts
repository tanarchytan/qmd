// =============================================================================
// Smart Chunking - Break Point Detection
// =============================================================================

import { getDefaultLlamaCpp } from "../llm.js";
import { isLocalEnabled } from "../remote-config.js";
import {
  CHUNK_SIZE_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_WINDOW_CHARS,
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CHUNK_WINDOW_TOKENS,
} from "./constants.js";
import type { ChunkStrategy } from "./types.js";

/**
 * A potential break point in the document with a base score indicating quality.
 */
export interface BreakPoint {
  pos: number;    // character position
  score: number;  // base score (higher = better break point)
  type: string;   // for debugging: 'h1', 'h2', 'blank', etc.
}

/**
 * A region where a code fence exists (between ``` markers).
 * We should never split inside a code fence.
 */
export interface CodeFenceRegion {
  start: number;  // position of opening ```
  end: number;    // position of closing ``` (or document end if unclosed)
}

/**
 * Patterns for detecting break points in markdown documents.
 * Higher scores indicate better places to split.
 * Scores are spread wide so headings decisively beat lower-quality breaks.
 * Order matters for scoring - more specific patterns first.
 */
export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, 'h1'],     // # but not ##
  [/\n#{2}(?!#)/g, 90, 'h2'],      // ## but not ###
  [/\n#{3}(?!#)/g, 80, 'h3'],      // ### but not ####
  [/\n#{4}(?!#)/g, 70, 'h4'],      // #### but not #####
  [/\n#{5}(?!#)/g, 60, 'h5'],      // ##### but not ######
  [/\n#{6}(?!#)/g, 50, 'h6'],      // ######
  [/\n```/g, 80, 'codeblock'],     // code block boundary (same as h3)
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],  // horizontal rule
  [/\n\n+/g, 20, 'blank'],         // paragraph boundary
  [/\n[-*]\s/g, 5, 'list'],        // unordered list item
  [/\n\d+\.\s/g, 5, 'numlist'],    // ordered list item
  [/\n/g, 1, 'newline'],           // minimal break
];

/**
 * Scan text for all potential break points.
 * Returns sorted array of break points with higher-scoring patterns taking precedence
 * when multiple patterns match the same position.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const points: BreakPoint[] = [];
  const seen = new Map<number, BreakPoint>();  // pos -> best break point at that pos

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!;
      const existing = seen.get(pos);
      // Keep higher score if position already seen
      if (!existing || score > existing.score) {
        const bp = { pos, score, type };
        seen.set(pos, bp);
      }
    }
  }

  // Convert to array and sort by position
  for (const bp of seen.values()) {
    points.push(bp);
  }
  return points.sort((a, b) => a.pos - b.pos);
}

/**
 * Find all code fence regions in the text.
 * Code fences are delimited by ``` and we should never split inside them.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const fencePattern = /\n```/g;
  let inFence = false;
  let fenceStart = 0;

  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length });
      inFence = false;
    }
  }

  // Handle unclosed fence - extends to end of document
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

/**
 * Check if a position is inside a code fence region.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some(f => pos > f.start && pos < f.end);
}

/**
 * Find the best cut position using scored break points with distance decay.
 *
 * Uses squared distance for gentler early decay - headings far back still win
 * over low-quality breaks near the target.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = []
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetCharPos) break;  // sorted, so we can stop

    // Skip break points inside code fences
    if (isInsideCodeFence(bp.pos, codeFences)) continue;

    const distance = targetCharPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - (normalizedDist * normalizedDist) * decayFactor;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

/**
 * Merge two sets of break points (e.g. regex + AST), keeping the highest
 * score at each position. Result is sorted by position.
 */
export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();
  for (const bp of a) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  for (const bp of b) {
    const existing = seen.get(bp.pos);
    if (!existing || bp.score > existing.score) {
      seen.set(bp.pos, bp);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
}

/**
 * Core chunk algorithm that operates on precomputed break points and code fences.
 * This is the shared implementation used by both regex-only and AST-aware chunking.
 */
export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: { text: string; pos: number }[] = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        codeFences
      );

      if (bestCutoff > charPos && bestCutoff <= targetEndPos) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    const lastChunkPos = chunks.at(-1)!.pos;
    if (charPos <= lastChunkPos) {
      charPos = endPos;
    }
  }

  return chunks;
}

/**
 * Chunk a document using regex-only break point detection.
 * This is the sync, backward-compatible API used by tests and legacy callers.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Async AST-aware chunking. Detects language from filepath, computes AST
 * break points for supported code files, merges with regex break points,
 * and delegates to the shared chunk algorithm.
 *
 * Falls back to regex-only when strategy is "regex", filepath is absent,
 * or language is unsupported.
 */
export async function chunkDocumentAsync(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
): Promise<{ text: string; pos: number }[]> {
  const regexPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  let breakPoints = regexPoints;
  if (chunkStrategy === "auto" && filepath) {
    const { getASTBreakPoints } = await import("../ast.js");
    const astPoints = await getASTBreakPoints(content, filepath);
    if (astPoints.length > 0) {
      breakPoints = mergeBreakPoints(regexPoints, astPoints);
    }
  }

  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

/**
 * Chunk a document by actual token count using the LLM tokenizer.
 * More accurate than character-based chunking but requires async.
 *
 * When filepath and chunkStrategy are provided, uses AST-aware break points
 * for supported code files.
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal
): Promise<{ text: string; pos: number; tokens: number }[]> {
  // Use moderate chars/token estimate (prose ~4, code ~2, mixed ~3)
  const avgCharsPerToken = 3;
  const maxChars = maxTokens * avgCharsPerToken;
  const overlapChars = overlapTokens * avgCharsPerToken;
  const windowChars = windowTokens * avgCharsPerToken;

  // Chunk in character space with conservative estimate
  let charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);

  // When local LLM is disabled, use char-based approximation for token counts
  if (!isLocalEnabled()) {
    return charChunks.map(chunk => ({
      text: chunk.text,
      pos: chunk.pos,
      tokens: Math.ceil(chunk.text.length / avgCharsPerToken),
    }));
  }

  const llm = getDefaultLlamaCpp();

  // Tokenize and split any chunks that still exceed limit
  const results: { text: string; pos: number; tokens: number }[] = [];

  for (const chunk of charChunks) {
    // Respect abort signal to avoid runaway tokenization
    if (signal?.aborted) break;

    const tokens = await llm.tokenize(chunk.text);

    if (tokens.length <= maxTokens) {
      results.push({ text: chunk.text, pos: chunk.pos, tokens: tokens.length });
    } else {
      // Chunk is still too large - split it further
      const actualCharsPerToken = chunk.text.length / tokens.length;
      const safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95); // 5% safety margin

      const subChunks = chunkDocument(chunk.text, safeMaxChars, Math.floor(overlapChars * actualCharsPerToken / 2), Math.floor(windowChars * actualCharsPerToken / 2));

      for (const subChunk of subChunks) {
        if (signal?.aborted) break;
        const subTokens = await llm.tokenize(subChunk.text);
        results.push({
          text: subChunk.text,
          pos: chunk.pos + subChunk.pos,
          tokens: subTokens.length,
        });
      }
    }
  }

  return results;
}
