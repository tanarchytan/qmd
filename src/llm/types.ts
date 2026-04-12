/**
 * llm/types.ts — shared types, default model URIs, and embedding format helpers.
 *
 * Split out from src/llm.ts. Zero runtime dependencies — safe to import from any
 * llm/ submodule without risking circular imports.
 */

// =============================================================================
// Default model URIs
// =============================================================================

// HuggingFace model URIs for node-llama-cpp
// Format: hf:<user>/<repo>/<file>
// Override via QMD_EMBED_MODEL env var (e.g. hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf)
export const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
export const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
// const DEFAULT_GENERATE_MODEL = "hf:ggml-org/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf";
export const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

// Alternative generation models for query expansion:
// LiquidAI LFM2 — hybrid architecture optimized for edge/on-device inference.
// Use these as base for fine-tuning with configs/sft_lfm2.yaml.
export const LFM2_GENERATE_MODEL = "hf:LiquidAI/LFM2-1.2B-GGUF/LFM2-1.2B-Q4_K_M.gguf";
export const LFM2_INSTRUCT_MODEL = "hf:LiquidAI/LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M.gguf";

// Legacy *_URI aliases kept for any external consumers that import the
// original names from "./llm.js".
export const DEFAULT_EMBED_MODEL_URI = DEFAULT_EMBED_MODEL;
export const DEFAULT_RERANK_MODEL_URI = DEFAULT_RERANK_MODEL;
export const DEFAULT_GENERATE_MODEL_URI = DEFAULT_GENERATE_MODEL;

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  return /qwen.*embed/i.test(modelUri) || /embed.*qwen/i.test(modelUri);
}

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma (default).
 * Uses Qwen3-Embedding instruct format when a Qwen embedding model is active.
 */
export function formatQueryForEmbedding(query: string, modelUri?: string): string {
  const uri = modelUri ?? process.env.QMD_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  if (isQwen3EmbeddingModel(uri)) {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`;
  }
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields (default).
 * Qwen3-Embedding encodes documents as raw text without special prefixes.
 */
export function formatDocForEmbedding(text: string, title?: string, modelUri?: string): string {
  const uri = modelUri ?? process.env.QMD_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  if (isQwen3EmbeddingModel(uri)) {
    // Qwen3-Embedding: documents are raw text, no task prefix
    return title ? `${title}\n${text}` : text;
  }
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// LLM data types
// =============================================================================

/**
 * Token with log probability
 */
export type TokenLogProb = {
  token: string;
  logprob: number;
};

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Generation result with optional logprobs
 */
export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
  /** LLM-extracted relevant content (only present when using LLM rerank mode) */
  extract?: string;
};

/**
 * Batch rerank result
 */
export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

/**
 * Model info
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for reranking
 */
export type RerankOptions = {
  model?: string;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes) */
  maxDuration?: number;
  /** External abort signal */
  signal?: AbortSignal;
  /** Debug name for logging */
  name?: string;
};

/**
 * Abstract LLM interface — implemented by LlamaCpp (local) and RemoteLLM (cloud).
 */
export interface LLM {
  /** Get embeddings for text */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /** Get embeddings for a batch of texts (some impls parallelize) */
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;

  /** Generate text completion */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;

  /** Check if a model exists/is available */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   * Returns a list of Queryable objects.
   */
  expandQuery(query: string, options?: { context?: string, includeLexical?: boolean }): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query.
   * Returns list of documents with relevance scores (higher = more relevant).
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;

  /** Dispose of resources */
  dispose(): Promise<void>;
}

/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

/**
 * Supported query types for different search backends
 */
export type QueryType = 'lex' | 'vec' | 'hyde';

/**
 * A single query and its target backend type
 */
export type Queryable = {
  type: QueryType;
  text: string;
};

/**
 * Document to rerank
 */
export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};
