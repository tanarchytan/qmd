/**
 * llm.ts - LLM abstraction layer for QMD using node-llama-cpp
 *
 * Provides embeddings, text generation, and reranking using local GGUF models.
 */

// node-llama-cpp loader split out to src/llm/loader.ts for shared access by
// sibling modules without circular imports back through this file.
import { loadLlamaCppModule } from "./llm/loader.js";
// Re-export model-pull utilities (moved to src/llm/pull.ts).
export { pullModels, DEFAULT_MODEL_CACHE_DIR } from "./llm/pull.js";
export type { PullResult } from "./llm/pull.js";
// Shared types + default model URIs + embedding format helpers (moved to src/llm/types.ts).
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GENERATE_MODEL,
} from "./llm/types.js";
import type {
  TokenLogProb,
  EmbeddingResult,
  GenerateResult,
  RerankDocumentResult,
  RerankResult,
  ModelInfo,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  LLMSessionOptions,
  ILLMSession,
  QueryType,
  Queryable,
  RerankDocument,
} from "./llm/types.js";
export {
  DEFAULT_EMBED_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GENERATE_MODEL,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  LFM2_GENERATE_MODEL,
  LFM2_INSTRUCT_MODEL,
  isQwen3EmbeddingModel,
  formatQueryForEmbedding,
  formatDocForEmbedding,
} from "./llm/types.js";
export type {
  TokenLogProb,
  EmbeddingResult,
  GenerateResult,
  RerankDocumentResult,
  RerankResult,
  ModelInfo,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  LLMSessionOptions,
  ILLMSession,
  QueryType,
  Queryable,
  RerankDocument,
} from "./llm/types.js";

// Type aliases (erased at compile time, no runtime import)
type Llama = any;
type LlamaModel = any;
type LlamaEmbeddingContext = any;
type LlamaToken = any;
import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from "fs";
// Inline to avoid circular dep with remote-config.ts
function isLocalEnabled(): boolean {
  const val = process.env.QMD_LOCAL?.toLowerCase();
  return val !== 'no' && val !== 'false' && val !== '0';
}

// Local model cache directory — kept here because LlamaCpp still references it
// directly below. When LlamaCpp moves to src/llm/local.ts this migrates too.
const MODEL_CACHE_DIR = process.env.XDG_CACHE_HOME
  ? join(process.env.XDG_CACHE_HOME, "qmd", "models")
  : join(homedir(), ".cache", "qmd", "models");

// =============================================================================
// LLM Interface
// =============================================================================

/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
  /**
   * Get embeddings for text
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Generate text completion
   */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;

  /**
   * Check if a model exists/is available
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   * Returns a list of Queryable objects.
   */
  expandQuery(query: string, options?: { context?: string, includeLexical?: boolean }): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query
   * Returns list of documents with relevance scores (higher = more relevant)
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

// =============================================================================
// node-llama-cpp Implementation
// =============================================================================

export type LlamaCppConfig = {
  embedModel?: string;
  generateModel?: string;
  rerankModel?: string;
  modelCacheDir?: string;
  /**
   * Context size used for query expansion generation contexts.
   * Default: 2048. Can also be set via QMD_EXPAND_CONTEXT_SIZE.
   */
  expandContextSize?: number;
  /**
   * Inactivity timeout in ms before unloading contexts (default: 2 minutes, 0 to disable).
   *
   * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
   * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
   * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
   */
  inactivityTimeoutMs?: number;
  /**
   * Whether to dispose models on inactivity (default: false).
   *
   * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
   * memory reclaim.
   */
  disposeModelsOnInactivity?: boolean;
};

/**
 * LLM implementation using node-llama-cpp
 */
// Default inactivity timeout: 5 minutes (keep models warm during typical search sessions)
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_EXPAND_CONTEXT_SIZE = 2048;

function resolveExpandContextSize(configValue?: number): number {
  if (configValue !== undefined) {
    if (!Number.isInteger(configValue) || configValue <= 0) {
      throw new Error(`Invalid expandContextSize: ${configValue}. Must be a positive integer.`);
    }
    return configValue;
  }

  const envValue = process.env.QMD_EXPAND_CONTEXT_SIZE?.trim();
  if (!envValue) return DEFAULT_EXPAND_CONTEXT_SIZE;

  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(
      `QMD Warning: invalid QMD_EXPAND_CONTEXT_SIZE="${envValue}", using default ${DEFAULT_EXPAND_CONTEXT_SIZE}.\n`
    );
    return DEFAULT_EXPAND_CONTEXT_SIZE;
  }
  return parsed;
}

export class LlamaCpp implements LLM {
  private readonly _ciMode = !!process.env.CI;
  private llama: Llama | null = null;
  private embedModel: LlamaModel | null = null;
  private embedContexts: LlamaEmbeddingContext[] = [];
  private generateModel: LlamaModel | null = null;
  private rerankModel: LlamaModel | null = null;
  private rerankContexts: Awaited<ReturnType<LlamaModel["createRankingContext"]>>[] = [];

  private embedModelUri: string;
  private generateModelUri: string;
  private rerankModelUri: string;
  private modelCacheDir: string;
  private expandContextSize: number;

  // Ensure we don't load the same model/context concurrently (which can allocate duplicate VRAM).
  private embedModelLoadPromise: Promise<LlamaModel> | null = null;
  private generateModelLoadPromise: Promise<LlamaModel> | null = null;
  private rerankModelLoadPromise: Promise<LlamaModel> | null = null;

  // Inactivity timer for auto-unloading models
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs: number;
  private disposeModelsOnInactivity: boolean;

  // Track disposal state to prevent double-dispose
  private disposed = false;


  constructor(config: LlamaCppConfig = {}) {
    this.embedModelUri = config.embedModel || process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL;
    this.generateModelUri = config.generateModel || process.env.QMD_GENERATE_MODEL || DEFAULT_GENERATE_MODEL;
    this.rerankModelUri = config.rerankModel || process.env.QMD_RERANK_MODEL || DEFAULT_RERANK_MODEL;
    this.modelCacheDir = config.modelCacheDir || MODEL_CACHE_DIR;
    this.expandContextSize = resolveExpandContextSize(config.expandContextSize);
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.disposeModelsOnInactivity = config.disposeModelsOnInactivity ?? false;
  }

  get embedModelName(): string {
    return this.embedModelUri;
  }

  /**
   * Reset the inactivity timer. Called after each model operation.
   * When timer fires, models are unloaded to free memory (if no active sessions).
   */
  private touchActivity(): void {
    // Clear existing timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Only set timer if we have disposable contexts and timeout is enabled
    if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(() => {
        // Check if session manager allows unloading
        // canUnloadLLM is defined later in this file - it checks the session manager
        // We use dynamic import pattern to avoid circular dependency issues
        if (typeof canUnloadLLM === 'function' && !canUnloadLLM()) {
          // Active sessions/operations - reschedule timer
          this.touchActivity();
          return;
        }
        this.unloadIdleResources().catch(err => {
          console.error("Error unloading idle resources:", err);
        });
      }, this.inactivityTimeoutMs);
      // Don't keep process alive just for this timer
      this.inactivityTimer.unref();
    }
  }

  /**
   * Check if any contexts are currently loaded (and therefore worth unloading on inactivity).
   */
  private hasLoadedContexts(): boolean {
    return !!(this.embedContexts.length > 0 || this.rerankContexts.length > 0);
  }

  /**
   * Unload idle resources but keep the instance alive for future use.
   *
   * By default, this disposes contexts (and their dependent sequences), while keeping models loaded.
   * This matches the intended lifecycle: model → context → sequence, where contexts are per-session.
   */
  async unloadIdleResources(): Promise<void> {
    // Don't unload if already disposed
    if (this.disposed) {
      return;
    }

    // Clear timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Dispose contexts first
    for (const ctx of this.embedContexts) {
      await ctx.dispose();
    }
    this.embedContexts = [];
    for (const ctx of this.rerankContexts) {
      await ctx.dispose();
    }
    this.rerankContexts = [];

    // Optionally dispose models too (opt-in)
    if (this.disposeModelsOnInactivity) {
      if (this.embedModel) {
        await this.embedModel.dispose();
        this.embedModel = null;
      }
      if (this.generateModel) {
        await this.generateModel.dispose();
        this.generateModel = null;
      }
      if (this.rerankModel) {
        await this.rerankModel.dispose();
        this.rerankModel = null;
      }
      // Reset load promises so models can be reloaded later
      this.embedModelLoadPromise = null;
      this.generateModelLoadPromise = null;
      this.rerankModelLoadPromise = null;
    }

    // Note: We keep llama instance alive - it's lightweight
  }

  /**
   * Ensure model cache directory exists
   */
  private ensureModelCacheDir(): void {
    if (!existsSync(this.modelCacheDir)) {
      mkdirSync(this.modelCacheDir, { recursive: true });
    }
  }

  /**
   * Initialize the llama instance (lazy)
   */
  private async ensureLlama(): Promise<Llama> {
    if (!this.llama) {
      // Allow override via QMD_LLAMA_GPU: "false" | "off" | "none" forces CPU
      const gpuOverride = (process.env.QMD_LLAMA_GPU ?? "").toLowerCase();
      const forceCpu = ["false", "off", "none", "disable", "disabled", "0"].includes(gpuOverride);

      // Use prebuilt binaries only (no cmake). Set QMD_LLAMA_BUILD=auto to allow building from source.
      const buildMode = process.env.QMD_LLAMA_BUILD === 'auto' ? 'autoAttempt' as const : 'never' as const;
      const mod = await loadLlamaCppModule();
      const loadLlama = async (gpu: "auto" | false) =>
        await mod.getLlama({
          build: buildMode,
          logLevel: mod.LlamaLogLevel.error,
          gpu,
        });

      let llama: Llama;
      if (forceCpu) {
        llama = await loadLlama(false);
      } else {
        try {
          llama = await loadLlama("auto");
        } catch (err) {
          // GPU backend (e.g. Vulkan on headless/driverless machines) can throw at init.
          // Fall back to CPU so qmd still works.
          process.stderr.write(
            `QMD Warning: GPU init failed (${err instanceof Error ? err.message : String(err)}), falling back to CPU.\n`
          );
          llama = await loadLlama(false);
        }
      }

      if (llama.gpu === false) {
        process.stderr.write(
          "QMD Warning: no GPU acceleration, running on CPU (slow). Run 'qmd status' for details.\n"
        );
      }
      this.llama = llama;
    }
    return this.llama;
  }

  /**
   * Resolve a model URI to a local path, downloading if needed
   */
  private async resolveModel(modelUri: string): Promise<string> {
    this.ensureModelCacheDir();
    // resolveModelFile handles HF URIs and downloads to the cache dir
    const mod = await loadLlamaCppModule();
    return await mod.resolveModelFile(modelUri, this.modelCacheDir);
  }

  /**
   * Load embedding model (lazy)
   */
  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) {
      return this.embedModel;
    }
    if (this.embedModelLoadPromise) {
      return await this.embedModelLoadPromise;
    }

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.embedModelUri);
      const model = await llama.loadModel({ modelPath });
      this.embedModel = model;
      // Model loading counts as activity - ping to keep alive
      this.touchActivity();
      return model;
    })();

    try {
      return await this.embedModelLoadPromise;
    } finally {
      // Keep the resolved model cached; clear only the in-flight promise.
      this.embedModelLoadPromise = null;
    }
  }

  /**
   * Compute how many parallel contexts to create.
   *
   * GPU: constrained by VRAM (25% of free, capped at 8).
   * CPU: constrained by cores. Splitting threads across contexts enables
   *      true parallelism (each context runs on its own cores). Use at most
   *      half the math cores, with at least 4 threads per context.
   */
  private async computeParallelism(perContextMB: number): Promise<number> {
    const llama = await this.ensureLlama();

    if (llama.gpu) {
      try {
        const vram = await llama.getVramState();
        const freeMB = vram.free / (1024 * 1024);
        const maxByVram = Math.floor((freeMB * 0.25) / perContextMB);
        return Math.max(1, Math.min(8, maxByVram));
      } catch {
        return 2;
      }
    }

    // CPU: split cores across contexts. At least 4 threads per context.
    const cores = llama.cpuMathCores || 4;
    const maxContexts = Math.floor(cores / 4);
    return Math.max(1, Math.min(4, maxContexts));
  }

  /**
   * Get the number of threads each context should use, given N parallel contexts.
   * Splits available math cores evenly across contexts.
   */
  private async threadsPerContext(parallelism: number): Promise<number> {
    const llama = await this.ensureLlama();
    if (llama.gpu) return 0; // GPU: let the library decide
    const cores = llama.cpuMathCores || 4;
    return Math.max(1, Math.floor(cores / parallelism));
  }

  /**
   * Load embedding contexts (lazy). Creates multiple for parallel embedding.
   * Uses promise guard to prevent concurrent context creation race condition.
   */
  private embedContextsCreatePromise: Promise<LlamaEmbeddingContext[]> | null = null;

  private async ensureEmbedContexts(): Promise<LlamaEmbeddingContext[]> {
    if (this.embedContexts.length > 0) {
      this.touchActivity();
      return this.embedContexts;
    }

    if (this.embedContextsCreatePromise) {
      return await this.embedContextsCreatePromise;
    }

    this.embedContextsCreatePromise = (async () => {
      const model = await this.ensureEmbedModel();
      // Embed contexts are ~143 MB each (nomic-embed 2048 ctx)
      const n = await this.computeParallelism(150);
      const threads = await this.threadsPerContext(n);
      for (let i = 0; i < n; i++) {
        try {
          this.embedContexts.push(await model.createEmbeddingContext({
            contextSize: LlamaCpp.EMBED_CONTEXT_SIZE,
            ...(threads > 0 ? { threads } : {}),
          }));
        } catch {
          if (this.embedContexts.length === 0) throw new Error("Failed to create any embedding context");
          break;
        }
      }
      this.touchActivity();
      return this.embedContexts;
    })();

    try {
      return await this.embedContextsCreatePromise;
    } finally {
      this.embedContextsCreatePromise = null;
    }
  }

  /**
   * Get a single embed context (for single-embed calls). Uses first from pool.
   */
  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    const contexts = await this.ensureEmbedContexts();
    return contexts[0]!;
  }

  /**
   * Load generation model (lazy) - context is created fresh per call
   */
  private async ensureGenerateModel(): Promise<LlamaModel> {
    if (!this.generateModel) {
      if (this.generateModelLoadPromise) {
        return await this.generateModelLoadPromise;
      }

      this.generateModelLoadPromise = (async () => {
        const llama = await this.ensureLlama();
        const modelPath = await this.resolveModel(this.generateModelUri);
        const model = await llama.loadModel({ modelPath });
        this.generateModel = model;
        return model;
      })();

      try {
        await this.generateModelLoadPromise;
      } finally {
        this.generateModelLoadPromise = null;
      }
    }
    this.touchActivity();
    if (!this.generateModel) {
      throw new Error("Generate model not loaded");
    }
    return this.generateModel;
  }

  /**
   * Load rerank model (lazy)
   */
  private async ensureRerankModel(): Promise<LlamaModel> {
    if (this.rerankModel) {
      return this.rerankModel;
    }
    if (this.rerankModelLoadPromise) {
      return await this.rerankModelLoadPromise;
    }

    this.rerankModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.rerankModelUri);
      const model = await llama.loadModel({ modelPath });
      this.rerankModel = model;
      // Model loading counts as activity - ping to keep alive
      this.touchActivity();
      return model;
    })();

    try {
      return await this.rerankModelLoadPromise;
    } finally {
      this.rerankModelLoadPromise = null;
    }
  }

  /**
   * Load rerank contexts (lazy). Creates multiple contexts for parallel ranking.
   * Each context has its own sequence, so they can evaluate independently.
   *
   * Tuning choices:
   * - contextSize 1024: reranking chunks are ~800 tokens max, 1024 is plenty
   * - flashAttention: ~20% less VRAM per context (568 vs 711 MB)
   * - Combined: drops from 11.6 GB (auto, no flash) to 568 MB per context (20×)
   */
  // Qwen3 reranker template adds ~200 tokens overhead (system prompt, tags, etc.)
  // Default 2048 was too small for longer documents (e.g. session transcripts,
  // CJK text, or large markdown files) — callers hit "input lengths exceed
  // context size" errors even after truncation because the overhead estimate
  // was insufficient.  4096 comfortably fits the largest real-world chunks
  // while staying well below the 40 960-token auto size.
  // Override with QMD_RERANK_CONTEXT_SIZE env var if you need more headroom.
  private static readonly RERANK_CONTEXT_SIZE: number = (() => {
    const v = parseInt(process.env.QMD_RERANK_CONTEXT_SIZE ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 4096;
  })();

  private static readonly EMBED_CONTEXT_SIZE: number = (() => {
    const v = parseInt(process.env.QMD_EMBED_CONTEXT_SIZE ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 2048;
  })();
  private async ensureRerankContexts(): Promise<Awaited<ReturnType<LlamaModel["createRankingContext"]>>[]> {
    if (this.rerankContexts.length === 0) {
      const model = await this.ensureRerankModel();
      // ~960 MB per context with flash attention at contextSize 2048
      const n = Math.min(await this.computeParallelism(1000), 4);
      const threads = await this.threadsPerContext(n);
      for (let i = 0; i < n; i++) {
        try {
          this.rerankContexts.push(await model.createRankingContext({
            contextSize: LlamaCpp.RERANK_CONTEXT_SIZE,
            flashAttention: true,
            ...(threads > 0 ? { threads } : {}),
          } as any));
        } catch {
          if (this.rerankContexts.length === 0) {
            // Flash attention might not be supported — retry without it
            try {
              this.rerankContexts.push(await model.createRankingContext({
                contextSize: LlamaCpp.RERANK_CONTEXT_SIZE,
                ...(threads > 0 ? { threads } : {}),
              }));
            } catch {
              throw new Error("Failed to create any rerank context");
            }
          }
          break;
        }
      }
    }
    this.touchActivity();
    return this.rerankContexts;
  }

  // ==========================================================================
  // Tokenization
  // ==========================================================================

  /**
   * Tokenize text using the embedding model's tokenizer
   * Returns tokenizer tokens (opaque type from node-llama-cpp)
   */
  async tokenize(text: string): Promise<readonly LlamaToken[]> {
    await this.ensureEmbedContext();  // Ensure model is loaded
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.tokenize(text);
  }

  /**
   * Count tokens in text using the embedding model's tokenizer
   */
  async countTokens(text: string): Promise<number> {
    const tokens = await this.tokenize(text);
    return tokens.length;
  }

  /**
   * Detokenize token IDs back to text
   */
  async detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    await this.ensureEmbedContext();
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.detokenize(tokens);
  }

  // ==========================================================================
  // Core API methods
  // ==========================================================================

  /**
   * Truncate text to fit within the embedding model's context window.
   * Uses the model's own tokenizer for accurate token counting, then
   * detokenizes back to text if truncation is needed.
   * Returns the (possibly truncated) text and whether truncation occurred.
   */
  private async truncateToContextSize(text: string): Promise<{ text: string; truncated: boolean }> {
    if (!this.embedModel) return { text, truncated: false };

    const maxTokens = this.embedModel.trainContextSize;
    if (maxTokens <= 0) return { text, truncated: false };

    const tokens = this.embedModel.tokenize(text);
    if (tokens.length <= maxTokens) return { text, truncated: false };

    // Leave a small margin (4 tokens) for BOS/EOS overhead
    const safeLimit = Math.max(1, maxTokens - 4);
    const truncatedTokens = tokens.slice(0, safeLimit);
    const truncatedText = this.embedModel.detokenize(truncatedTokens);
    return { text: truncatedText, truncated: true };
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    try {
      const context = await this.ensureEmbedContext();

      // Guard: truncate text that exceeds model context window to prevent GGML crash
      const { text: safeText, truncated } = await this.truncateToContextSize(text);
      if (truncated) {
        console.warn(`⚠ Text truncated to fit embedding context (${this.embedModel?.trainContextSize} tokens)`);
      }

      const embedding = await context.getEmbeddingFor(safeText);

      return {
        embedding: Array.from(embedding.vector),
        model: options.model ?? this.embedModelUri,
      };
    } catch (error) {
      console.error("Embedding error:", error);
      return null;
    }
  }

  /**
   * Batch embed multiple texts efficiently
   * Uses Promise.all for parallel embedding - node-llama-cpp handles batching internally
   */
  async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<(EmbeddingResult | null)[]> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    if (texts.length === 0) return [];

    try {
      const contexts = await this.ensureEmbedContexts();
      const n = contexts.length;

      if (n === 1) {
        // Single context: sequential (no point splitting)
        const context = contexts[0]!;
        const embeddings: ({ embedding: number[]; model: string } | null)[] = [];
        for (const text of texts) {
          try {
            const { text: safeText, truncated } = await this.truncateToContextSize(text);
            if (truncated) {
              console.warn(`⚠ Batch text truncated to fit embedding context (${this.embedModel?.trainContextSize} tokens)`);
            }
            const embedding = await context.getEmbeddingFor(safeText);
            this.touchActivity();
            embeddings.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
          } catch (err) {
            console.error("Embedding error for text:", err);
            embeddings.push(null);
          }
        }
        return embeddings;
      }

      // Multiple contexts: split texts across contexts for parallel evaluation
      const chunkSize = Math.ceil(texts.length / n);
      const chunks = Array.from({ length: n }, (_, i) =>
        texts.slice(i * chunkSize, (i + 1) * chunkSize)
      );

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, i) => {
          const ctx = contexts[i]!;
          const results: (EmbeddingResult | null)[] = [];
          for (const text of chunk) {
            try {
              const { text: safeText, truncated } = await this.truncateToContextSize(text);
              if (truncated) {
                console.warn(`⚠ Batch text truncated to fit embedding context (${this.embedModel?.trainContextSize} tokens)`);
              }
              const embedding = await ctx.getEmbeddingFor(safeText);
              this.touchActivity();
              results.push({ embedding: Array.from(embedding.vector), model: options.model ?? this.embedModelUri });
            } catch (err) {
              console.error("Embedding error for text:", err);
              results.push(null);
            }
          }
          return results;
        })
      );

      return chunkResults.flat();
    } catch (error) {
      console.error("Batch embedding error:", error);
      return texts.map(() => null);
    }
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    // Ensure model is loaded
    await this.ensureGenerateModel();

    // Create fresh context -> sequence -> session for each call
    const mod = await loadLlamaCppModule();
    const context = await this.generateModel!.createContext();
    const sequence = context.getSequence();
    const session = new mod.LlamaChatSession({ contextSequence: sequence });

    const maxTokens = options.maxTokens ?? 150;
    // Qwen3 recommends temp=0.7, topP=0.8, topK=20 for non-thinking mode
    // DO NOT use greedy decoding (temp=0) - causes repetition loops
    const temperature = options.temperature ?? 0.7;

    let result = "";
    try {
      await session.prompt(prompt, {
        maxTokens,
        temperature,
        topK: 20,
        topP: 0.8,
        onTextChunk: (text: string) => {
          result += text;
        },
      });

      return {
        text: result,
        model: this.generateModelUri,
        done: true,
      };
    } finally {
      // Dispose context (which disposes dependent sequences/sessions per lifecycle rules)
      await context.dispose();
    }
  }

  async modelExists(modelUri: string): Promise<ModelInfo> {
    // For HuggingFace URIs, we assume they exist
    // For local paths, check if file exists
    if (modelUri.startsWith("hf:")) {
      return { name: modelUri, exists: true };
    }

    const exists = existsSync(modelUri);
    return {
      name: modelUri,
      exists,
      path: exists ? modelUri : undefined,
    };
  }

  // ==========================================================================
  // High-level abstractions
  // ==========================================================================

  async expandQuery(query: string, options: { context?: string, includeLexical?: boolean, intent?: string } = {}): Promise<Queryable[]> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    const llama = await this.ensureLlama();
    await this.ensureGenerateModel();

    const includeLexical = options.includeLexical ?? true;
    const context = options.context;

    const grammar = await llama.createGrammar({
      grammar: `
        root ::= line+
        line ::= type ": " content "\\n"
        type ::= "lex" | "vec" | "hyde"
        content ::= [^\\n]+
      `
    });

    const intent = options.intent;
    const prompt = intent
      ? `/no_think Expand this search query: ${query}\nQuery intent: ${intent}`
      : `/no_think Expand this search query: ${query}`;

    // Create a bounded context for expansion to prevent large default VRAM allocations.
    const mod = await loadLlamaCppModule();
    const genContext = await this.generateModel!.createContext({
      contextSize: this.expandContextSize,
    });
    const sequence = genContext.getSequence();
    const session = new mod.LlamaChatSession({ contextSequence: sequence });

    try {
      // Qwen3 recommended settings for non-thinking mode:
      // temp=0.7, topP=0.8, topK=20, presence_penalty for repetition
      // DO NOT use greedy decoding (temp=0) - causes infinite loops
      const result = await session.prompt(prompt, {
        grammar,
        maxTokens: 600,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        repeatPenalty: {
          lastTokens: 64,
          presencePenalty: 0.5,
        },
      });

      const lines = result.trim().split("\n");
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

      const hasQueryTerm = (text: string): boolean => {
        const lower = text.toLowerCase();
        if (queryTerms.length === 0) return true;
        return queryTerms.some(term => lower.includes(term));
      };

      const queryables: Queryable[] = lines
        .map((line: string): Queryable | null => {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) return null;
          const type = line.slice(0, colonIdx).trim();
          if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
          const text = line.slice(colonIdx + 1).trim();
          if (!hasQueryTerm(text)) return null;
          return { type: type as QueryType, text };
        })
        .filter((q: Queryable | null): q is Queryable => q !== null);

      // Filter out lex entries if not requested
      const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
      if (filtered.length > 0) return filtered;

      const fallback: Queryable[] = [
        { type: 'hyde', text: `Information about ${query}` },
        { type: 'lex', text: query },
        { type: 'vec', text: query },
      ];
      return includeLexical ? fallback : fallback.filter(q => q.type !== 'lex');
    } catch (error) {
      console.error("Structured query expansion failed:", error);
      // Fallback to original query
      const fallback: Queryable[] = [{ type: 'vec', text: query }];
      if (includeLexical) fallback.unshift({ type: 'lex', text: query });
      return fallback;
    } finally {
      await genContext.dispose();
    }
  }

  // Qwen3 reranker chat template overhead (system prompt, tags, separators).
  // Measured at ~350 tokens on real queries; use 512 as a safe upper bound so
  // the truncation budget never lets a document slip past the context limit.
  private static readonly RERANK_TEMPLATE_OVERHEAD = 512;
  private static readonly RERANK_TARGET_DOCS_PER_CONTEXT = 10;

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    if (this._ciMode) throw new Error("LLM operations are disabled in CI (set CI=true)");
    // Ping activity at start to keep models alive during this operation
    this.touchActivity();

    const contexts = await this.ensureRerankContexts();
    const model = await this.ensureRerankModel();

    // Truncate documents that would exceed the rerank context size.
    // Budget = contextSize - template overhead - query tokens
    const queryTokens = model.tokenize(query).length;
    const maxDocTokens = LlamaCpp.RERANK_CONTEXT_SIZE - LlamaCpp.RERANK_TEMPLATE_OVERHEAD - queryTokens;
    const truncationCache = new Map<string, string>();

    const truncatedDocs = documents.map((doc) => {
      const cached = truncationCache.get(doc.text);
      if (cached !== undefined) {
        return cached === doc.text ? doc : { ...doc, text: cached };
      }

      const tokens = model.tokenize(doc.text);
      const truncatedText = tokens.length <= maxDocTokens
        ? doc.text
        : model.detokenize(tokens.slice(0, maxDocTokens));
      truncationCache.set(doc.text, truncatedText);

      if (truncatedText === doc.text) return doc;
      return { ...doc, text: truncatedText };
    });

    // Deduplicate identical effective texts before scoring.
    // This avoids redundant work for repeated chunks and fixes collisions where
    // multiple docs map to the same chunk text.
    const textToDocs = new Map<string, { file: string; index: number }[]>();
    truncatedDocs.forEach((doc, index) => {
      const existing = textToDocs.get(doc.text);
      if (existing) {
        existing.push({ file: doc.file, index });
      } else {
        textToDocs.set(doc.text, [{ file: doc.file, index }]);
      }
    });

    // Extract just the text for ranking
    const texts = Array.from(textToDocs.keys());

    // Split documents across contexts for parallel evaluation.
    // Each context has its own sequence with a lock, so parallelism comes
    // from multiple contexts evaluating different chunks simultaneously.
    const activeContextCount = Math.max(
      1,
      Math.min(
        contexts.length,
        Math.ceil(texts.length / LlamaCpp.RERANK_TARGET_DOCS_PER_CONTEXT)
      )
    );
    const activeContexts = contexts.slice(0, activeContextCount);
    const chunkSize = Math.ceil(texts.length / activeContexts.length);
    const chunks = Array.from({ length: activeContexts.length }, (_, i) =>
      texts.slice(i * chunkSize, (i + 1) * chunkSize)
    ).filter(chunk => chunk.length > 0);

    const allScores = await Promise.all(
      chunks.map((chunk, i) => activeContexts[i]!.rankAll(query, chunk))
    );

    // Reassemble scores in original order and sort
    const flatScores = allScores.flat();
    const ranked = texts
      .map((text, i) => ({ document: text, score: flatScores[i]! }))
      .sort((a, b) => b.score - a.score);

    // Map back to our result format.
    const results: RerankDocumentResult[] = [];
    for (const item of ranked) {
      const docInfos = textToDocs.get(item.document) ?? [];
      for (const docInfo of docInfos) {
        results.push({
          file: docInfo.file,
          score: item.score,
          index: docInfo.index,
        });
      }
    }

    return {
      results,
      model: this.rerankModelUri,
    };
  }

  /**
   * Get device/GPU info for status display.
   * Initializes llama if not already done.
   */
  async getDeviceInfo(): Promise<{
    gpu: string | false;
    gpuOffloading: boolean;
    gpuDevices: string[];
    vram?: { total: number; used: number; free: number };
    cpuCores: number;
  }> {
    const llama = await this.ensureLlama();
    const gpuDevices = await llama.getGpuDeviceNames();
    let vram: { total: number; used: number; free: number } | undefined;
    if (llama.gpu) {
      try {
        const state = await llama.getVramState();
        vram = { total: state.total, used: state.used, free: state.free };
      } catch { /* no vram info */ }
    }
    return {
      gpu: llama.gpu,
      gpuOffloading: llama.supportsGpuOffloading,
      gpuDevices,
      vram,
      cpuCores: llama.cpuMathCores,
    };
  }

  async dispose(): Promise<void> {
    // Prevent double-dispose
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Clear inactivity timer
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    // Disposing llama cascades to models and contexts automatically
    // See: https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
    // Note: llama.dispose() can hang indefinitely, so we use a timeout
    if (this.llama) {
      const disposePromise = this.llama.dispose();
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await Promise.race([disposePromise, timeoutPromise]);
    }

    // Clear references
    this.embedContexts = [];
    this.rerankContexts = [];
    this.embedModel = null;
    this.generateModel = null;
    this.rerankModel = null;
    this.llama = null;

    // Clear any in-flight load/create promises
    this.embedModelLoadPromise = null;
    this.embedContextsCreatePromise = null;
    this.generateModelLoadPromise = null;
    this.rerankModelLoadPromise = null;
  }
}

// =============================================================================
// Session Management Layer
// =============================================================================

/**
 * Manages LLM session lifecycle with reference counting.
 * Coordinates with LlamaCpp idle timeout to prevent disposal during active sessions.
 */
class LLMSessionManager {
  private llm: LlamaCpp;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LlamaCpp) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  /**
   * Returns true only when both session count and in-flight operations are 0.
   * Used by LlamaCpp to determine if idle unload is safe.
   */
  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlamaCpp(): LlamaCpp {
    return this.llm;
  }
}

/**
 * Error thrown when an operation is attempted on a released or aborted session.
 */
export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

/**
 * Scoped LLM session with automatic lifecycle management.
 * Wraps LlamaCpp methods with operation tracking and abort handling.
 */
class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => {
          this.abortController.abort(options.signal!.reason);
        }, { once: true });
      }
    }

    // Set up max duration timer
    const maxDuration = options.maxDuration ?? 10 * 60 * 1000; // Default 10 minutes
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`));
      }, maxDuration);
      this.maxDurationTimer.unref(); // Don't keep process alive
    }

    // Acquire session lease
    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Release the session and decrement ref count.
   * Called automatically by withLLMSession when the callback completes.
   */
  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  /**
   * Wrap an operation with tracking and abort checking.
   */
  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      // Check abort before starting
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(
          this.abortController.signal.reason?.message || "Session aborted"
        );
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withOperation(() => this.manager.getLlamaCpp().embed(text, options));
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().embedBatch(texts, options));
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().expandQuery(query, options));
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions
  ): Promise<RerankResult> {
    return this.withOperation(() => this.manager.getLlamaCpp().rerank(query, documents, options));
  }
}

// Session manager for the default LlamaCpp instance
let defaultSessionManager: LLMSessionManager | null = null;

/**
 * Get the session manager for the default LlamaCpp instance.
 */
function getSessionManager(): LLMSessionManager {
  const llm = getDefaultLlamaCpp();
  if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
    defaultSessionManager = new LLMSessionManager(llm);
  }
  return defaultSessionManager;
}

/**
 * Execute a function with a scoped LLM session.
 * The session provides lifecycle guarantees - resources won't be disposed mid-operation.
 *
 * @example
 * ```typescript
 * await withLLMSession(async (session) => {
 *   const expanded = await session.expandQuery(query);
 *   const embeddings = await session.embedBatch(texts);
 *   const reranked = await session.rerank(query, docs);
 *   return reranked;
 * }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
 * ```
 */
export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = getSessionManager();
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Execute a function with a scoped LLM session using a specific LlamaCpp instance.
 * Unlike withLLMSession, this does not use the global singleton.
 */
export async function withLLMSessionForLlm<T>(
  llm: LlamaCpp,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = new LLMSessionManager(llm);
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Check if idle unload is safe (no active sessions or operations).
 * Used internally by LlamaCpp idle timer.
 */
export function canUnloadLLM(): boolean {
  if (!defaultSessionManager) return true;
  return defaultSessionManager.canUnload();
}

// =============================================================================
// Singleton for default LlamaCpp instance
// =============================================================================

let defaultLlamaCpp: LlamaCpp | null = null;

/**
 * Get the default LlamaCpp instance (creates one if needed).
 * Throws when QMD_LOCAL=no — callers should check remote first.
 */
export function getDefaultLlamaCpp(): LlamaCpp {
  if (!isLocalEnabled()) {
    throw new Error("Local LLM disabled (QMD_LOCAL=no). Configure remote providers or set QMD_LOCAL=yes.");
  }
  if (!defaultLlamaCpp) {
    defaultLlamaCpp = new LlamaCpp();
  }
  return defaultLlamaCpp;
}

/**
 * Set a custom default LlamaCpp instance (useful for testing)
 */
export function setDefaultLlamaCpp(llm: LlamaCpp | null): void {
  defaultLlamaCpp = llm;
}

/**
 * Dispose the default LlamaCpp instance if it exists.
 * Call this before process exit to prevent NAPI crashes.
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}

// =============================================================================
// Remote LLM (Cloud Providers: api / url / gemini, per-operation config)
// =============================================================================

export type OperationProvider = 'api' | 'url' | 'gemini';

export type OperationConfig = {
  provider: OperationProvider;
  apiKey: string;
  url?: string;
  model?: string;
};

export type RemoteLLMConfig = {
  embed?: OperationConfig & { dimensions?: number };
  rerank?: OperationConfig & { mode?: 'llm' | 'rerank' };
  queryExpansion?: OperationConfig;
  /** Optional per-operation timeouts (ms). */
  timeoutsMs?: {
    embed?: number;
    rerank?: number;
    generate?: number;
  };
};

/**
 * Remote fetch with:
 * - Timeout (AbortController)
 * - Exponential backoff retry with jitter (maxAttempts default: 3)
 * - Better errors (provider/op + HTTP status + response snippet)
 * - Keep-alive hint header
 */
async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: {
    provider: string;
    operation: "embed" | "rerank" | "generate";
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
  },
): Promise<Response> {
  const provider = opts.provider;
  const operation = opts.operation;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = Math.max(50, opts.baseDelayMs ?? 500);

  const DEFAULT_TIMEOUTS_MS = {
    embed: 30_000,
    rerank: 15_000,
    generate: 60_000,
  } as const;

  const envTimeoutMs = (() => {
    const raw = process.env.QMD_TIMEOUT_MS;
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.round(parsed);
  })();

  const timeoutMs = Math.max(
    1,
    Math.round(
      opts.timeoutMs
        ?? envTimeoutMs
        ?? (operation === "embed"
          ? DEFAULT_TIMEOUTS_MS.embed
          : operation === "rerank"
            ? DEFAULT_TIMEOUTS_MS.rerank
            : DEFAULT_TIMEOUTS_MS.generate)
    )
  );

  const url = (() => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
  })();

  const isRetryableStatus = (status: number): boolean =>
    status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

  const getRetryAfterMs = (resp: Response): number | undefined => {
    const raw = resp.headers.get("retry-after");
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) return undefined;
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const backoffDelayMs = (attempt: number): number => {
    const exp = Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.random() * baseDelayMs;
    return Math.min(30_000, Math.round(baseDelayMs * exp + jitter));
  };

  const readBodySnippet = async (resp: Response, limit = 500): Promise<string> => {
    try {
      const text = await resp.text();
      const trimmed = text.trim();
      if (!trimmed) return "";
      return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
    } catch {
      return "";
    }
  };

  const initWithKeepAlive: RequestInit | undefined = init
    ? {
      ...init,
      headers: (() => {
        const headers = new Headers(init.headers);
        if (!headers.has("connection")) headers.set("Connection", "keep-alive");
        return headers;
      })(),
    }
    : init;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

    if (initWithKeepAlive?.signal) {
      const parent = initWithKeepAlive.signal;
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
      }
    }

    let resp: Response | null = null;
    let fetchErr: unknown = null;

    try {
      resp = await fetch(input, { ...(initWithKeepAlive || {}), signal: controller.signal });
    } catch (err) {
      fetchErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (resp) {
      if (resp.ok) return resp;

      const status = resp.status;
      const snippet = await readBodySnippet(resp);
      const hint = status === 401 ? ' — check your QMD_*_API_KEY'
        : status === 403 ? ' — API key may lack permissions'
        : status === 404 ? ' — check your QMD_*_URL (endpoint not found)'
        : status === 422 ? ' — check your QMD_*_MODEL (invalid model name)'
        : '';
      const msg = `[${provider}] ${operation} failed (HTTP ${status}${hint}) ${url}${snippet ? ` — ${snippet}` : ""}`;

      const retryable = isRetryableStatus(status);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(msg);
      }

      const retryAfterMs = getRetryAfterMs(resp);
      const delayMs = Math.max(retryAfterMs ?? 0, backoffDelayMs(attempt));
      process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
      await sleep(delayMs);
      continue;
    }

    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const msg = `[${provider}] ${operation} error ${url} — ${errMsg}`;

    if (attempt === maxAttempts) {
      throw new Error(msg);
    }

    const delayMs = backoffDelayMs(attempt);
    process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
    await sleep(delayMs);
  }

  throw new Error(`[${provider}] ${operation} failed: exhausted retries`);
}

// =============================================================================
// Rerank prompt: loads from ~/.config/qmd/rerank-prompt.txt if it exists,
// otherwise uses the built-in default.
// =============================================================================

const DEFAULT_RERANK_PROMPT = `你是记忆检索助手。根据查询从候选文档中筛选并提取相关信息。

查询：{{query}}

候选文档：
{{documents}}

规则：
1. 只提取与查询直接相关的文档内容，忽略不相关的
2. 每篇用 [编号] 开头，后面跟提取的核心内容
3. 用纯文本输出，不要JSON，不要markdown格式符
4. 没有相关文档则输出 NONE
5. 多篇文档内容相同或高度重复时，只提取第一篇，跳过后续重复
6. 优先选择原始数据源（如日记、笔记、配置记录），跳过「对话/搜索会话记录」类文档——即包含 memory_search、tool_use、tool_result、assistant回复搜索结果 等痕迹的文档，这些是之前搜索产生的二手转述，不是一手信息

示例格式：
[0] 提取的核心内容
[3] 另一篇的核心内容`;

function buildRerankPrompt(query: string, docsText: string): string {
  const configDir = process.env.QMD_CONFIG_DIR || join(homedir(), ".config", "qmd");
  const promptPath = join(configDir, "rerank-prompt.txt");
  let template = DEFAULT_RERANK_PROMPT;
  try {
    if (existsSync(promptPath)) {
      template = readFileSync(promptPath, "utf-8");
    }
  } catch { /* ignore read errors, use default */ }
  return template.replace(/\{\{query\}\}/g, query).replace(/\{\{documents\}\}/g, docsText);
}

export class RemoteLLM implements LLM {
  private readonly config: RemoteLLMConfig;

  constructor(config: RemoteLLMConfig) {
    this.config = config;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    if (!this.config.embed) throw new Error("RemoteLLM.embed() requires embed config. Set QMD_EMBED_PROVIDER.");
    const results = await this._embedTexts([text], options);
    return results[0] ?? null;
  }

  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("RemoteLLM.generate() is not implemented.");
  }

  async modelExists(_model: string): Promise<ModelInfo> {
    throw new Error("RemoteLLM.modelExists() is not implemented.");
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    const cfg = this.config.queryExpansion;
    if (!cfg) return this.fallbackExpansion(query, options?.includeLexical ?? true);

    const includeLexical = options?.includeLexical ?? true;
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = cfg.model;
    const timeoutMs = this.config.timeoutsMs?.generate;

    const prompt = [
      "Expand this search query into exactly 3 lines (no more, no less):",
      "lex: keyword terms (space-separated, not a sentence)",
      "vec: semantic search query",
      "hyde: hypothetical document snippet",
      "",
      `Query: ${query}`,
    ].join("\n");

    try {
      if (provider === 'gemini') {
        const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const geminiModel = model || 'gemini-2.5-flash';
        const resp = await fetchWithRetry(
          `${baseUrl}/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
            }),
          },
          { provider: "gemini", operation: "generate", timeoutMs },
        );
        const data = await resp.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return this.parseExpansionResult(text, query, includeLexical);
      } else {
        // 'api' or 'url'
        const url = provider === 'api'
          ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
          : cfg.url!;
        if (!url || url === '/chat/completions') throw new Error("QMD_QUERY_EXPANSION_URL is required. Set the base URL (api) or full endpoint (url) for query expansion.");
        const body: Record<string, unknown> = {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        };
        if (model) body.model = model;
        if (model && model.toLowerCase().includes('qwen3')) body.enable_thinking = false;
        const resp = await fetchWithRetry(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, { provider, operation: "generate", timeoutMs });
        const data = await resp.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content || "";
        return this.parseExpansionResult(text, query, includeLexical);
      }
    } catch (err) {
      const attemptedUrl = cfg.provider === 'gemini'
        ? `${(cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}/v1beta/models/...`
        : (cfg.provider === 'api' ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions` : cfg.url || '(no url)');
      process.stderr.write(`[queryExpansion] ${attemptedUrl} error: ${err}\n`);
      return this.fallbackExpansion(query, includeLexical);
    }
  }

  /**
   * Send a freeform prompt via the query expansion provider and get text back.
   * Used for memory extraction, LLM conflict resolution, and other non-search calls.
   */
  async chatComplete(prompt: string): Promise<string | null> {
    const cfg = this.config.queryExpansion;
    if (!cfg) return null;
    // Quality fix A+B: pin model + seed for reproducible extraction calls.
    // gemini-2.5-flash → gemini-2.5-flash-001 (Apr 2026 stable checkpoint)
    const SEED = 42;
    // Quality fix C: file-based response cache. Eval scripts set
    // QMD_LLM_CACHE_PATH to opt in (production code uses an in-memory map).
    const cachePath = process.env.QMD_LLM_CACHE_PATH;
    let cacheGet: ((p: string, m: string) => string | null) | null = null;
    let cacheSet: ((p: string, m: string, v: string) => void) | null = null;
    if (cachePath && process.env.QMD_LLM_CACHE !== "off") {
      try {
        const { openCache } = await import("../evaluate/_shared/llm-cache.js");
        const cache = openCache(cachePath);
        cacheGet = (p, m) => cache.get({ model: m, temperature: 0, seed: SEED, prompt: p });
        cacheSet = (p, m, v) => cache.set({ model: m, temperature: 0, seed: SEED, prompt: p }, v);
      } catch { /* cache optional */ }
    }
    try {
      if (cfg.provider === 'gemini') {
        const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const model = cfg.model || 'gemini-2.5-flash';
        if (cacheGet) {
          const c = cacheGet(prompt, model);
          if (c != null) return c;
        }
        const resp = await fetchWithRetry(
          `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, seed: SEED, maxOutputTokens: 1000 },
            }),
          },
          { provider: "gemini", operation: "generate", timeoutMs: this.config.timeoutsMs?.generate },
        );
        const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (text && cacheSet) cacheSet(prompt, model, text);
        return text;
      } else {
        const url = cfg.provider === 'api'
          ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
          : cfg.url!;
        if (!url || url === '/chat/completions') return null;
        const body: Record<string, unknown> = {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
          temperature: 0,
          seed: SEED,
        };
        if (cfg.model) body.model = cfg.model;
        const resp = await fetchWithRetry(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, { provider: cfg.provider, operation: "generate", timeoutMs: this.config.timeoutsMs?.generate });
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content || null;
      }
    } catch (err) {
      process.stderr.write(`[chatComplete] error: ${err}\n`);
      return null;
    }
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    const cfg = this.config.rerank;
    if (!cfg) throw new Error("RemoteLLM.rerank() requires rerank config. Set QMD_RERANK_PROVIDER.");

    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = options.model || cfg.model;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutsMs?.rerank;
    const mode = cfg.mode ?? (provider === 'url' ? 'rerank' : 'llm');

    if (provider === 'gemini') {
      return this._rerankWithGemini(query, documents, cfg, model, timeoutMs);
    }

    if (mode === 'rerank') {
      const url = provider === 'api'
        ? `${(cfg.url || '').replace(/\/$/, '')}/rerank`
        : cfg.url!;
      if (!url || url === '/rerank') throw new Error("QMD_RERANK_URL is required. Set the base URL (api) or full endpoint (url) for reranking.");

      const resp = await fetchWithRetry(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(model ? { model } : {}),
          query,
          documents: documents.map(d => d.text),
          top_n: Math.max(1, documents.length),
        }),
      }, { provider, operation: "rerank", timeoutMs });

      const data = await resp.json() as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      const results: RerankDocumentResult[] = (data.results || [])
        .map(item => {
          const doc = documents[item.index];
          if (!doc) return null;
          return { file: doc.file, score: item.relevance_score, index: item.index };
        })
        .filter((item): item is RerankDocumentResult => item !== null);
      return { results, model: model || "rerank" };
    }

    // LLM chat-based rerank
    const url = provider === 'api'
      ? `${(cfg.url || '').replace(/\/$/, '')}/chat/completions`
      : cfg.url!;
    if (!url || url === '/chat/completions') throw new Error("QMD_RERANK_URL is required. Set the base URL (api) or full endpoint (url) for LLM-based reranking.");

    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = buildRerankPrompt(query, docsText);
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 2000,
    };
    if (model) body.model = model;

    const resp = await fetchWithRetry(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, { provider, operation: "rerank", timeoutMs });

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content || "";
    const parsed = this.parsePlainTextExtracts(rawText, documents.length);
    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`[rerank llm] unexpected response format: ${rawText.slice(0, 200)}\n`);
    }
    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({ file: doc.file, score: 1.0 - rank * 0.05, index: item.index, extract: item.extract || undefined });
    }
    return { results, model: model || "llm" };

  }

  async dispose(): Promise<void> {
    // No-op: RemoteLLM has no local resources to dispose.
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    if (!this.config.embed) throw new Error("RemoteLLM.embedBatch() requires embed config. Set QMD_EMBED_PROVIDER.");
    return this._embedTexts(texts);
  }

  private async _embedTexts(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    const cfg = this.config.embed!;
    const provider = cfg.provider;
    const apiKey = cfg.apiKey;
    const model = options?.model || cfg.model;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutsMs?.embed;
    // BATCH_SIZE bumped from 32 → 64. ZeroEntropy and OpenAI-compatible
    // embed APIs accept up to 100-256 per request; 64 halves the round-trips
    // for large ingests without risking provider limits.
    const BATCH_SIZE = 64;
    const allResults: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const input = batch.length === 1 ? batch[0] : batch;

      try {
        if (provider === 'api') {
          const baseUrl = (cfg.url || '').replace(/\/$/, '');
          if (!baseUrl) throw new Error("QMD_EMBED_URL is required when QMD_EMBED_PROVIDER=api. Set the base URL of your embedding endpoint (e.g. https://api.openai.com/v1).");
          const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ...(model ? { model } : {}), input, encoding_format: "float" }),
          }, { provider: "api", operation: "embed", timeoutMs });

          const data = await resp.json() as {
            data?: Array<{ embedding: number[]; index?: number }>;
            model?: string;
          };
          const usedModel = data.model || model || "unknown";
          for (const item of data.data || []) {
            const idx = (item.index ?? 0) + i;
            if (idx < allResults.length && item.embedding) {
              allResults[idx] = { embedding: item.embedding, model: usedModel };
            }
          }
        } else if (provider === 'url') {
          const url = cfg.url;
          if (!url) throw new Error("QMD_EMBED_URL is required when QMD_EMBED_PROVIDER=url. Set the full endpoint URL for embedding.");
          const body: Record<string, unknown> = { input, input_type: "document" };
          if (model) body.model = model;
          if (cfg.dimensions) body.dimensions = cfg.dimensions;
          const resp = await fetchWithRetry(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }, { provider: "url", operation: "embed", timeoutMs });

          const data = await resp.json() as {
            data?: Array<{ embedding: number[]; index?: number }>;
            results?: Array<{ embedding: number[] | string }>;
            model?: string;
          };
          const usedModel = data.model || model || "unknown";
          if (data.data && data.data.length > 0) {
            for (const item of data.data) {
              const idx = (item.index ?? 0) + i;
              if (idx < allResults.length && item.embedding) {
                allResults[idx] = { embedding: item.embedding, model: usedModel };
              }
            }
          } else if (data.results && data.results.length > 0) {
            for (let j = 0; j < data.results.length; j++) {
              const r = data.results[j]!;
              if (typeof r.embedding !== 'string' && r.embedding) {
                allResults[i + j] = { embedding: r.embedding, model: usedModel };
              }
            }
          }
        } else {
          throw new Error(`Unsupported embed provider: ${provider}. Use 'api' or 'url'.`);
        }
      } catch (err) {
        process.stderr.write(`[embed] batch offset ${i} error: ${err}\n`);
      }
    }
    return allResults;
  }

  private async _rerankWithGemini(
    query: string,
    documents: RerankDocument[],
    cfg: OperationConfig,
    model: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<RerankResult> {
    const baseUrl = (cfg.url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const geminiModel = model || 'gemini-2.5-flash';
    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = buildRerankPrompt(query, docsText);

    const resp = await fetchWithRetry(
      `${baseUrl}/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
      { provider: "gemini", operation: "rerank", timeoutMs },
    );

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = this.parsePlainTextExtracts(rawText, documents.length);
    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`Gemini rerank: unexpected response format: ${rawText.slice(0, 200)}\n`);
    }
    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({ file: doc.file, score: 1.0 - rank * 0.05, index: item.index, extract: item.extract || undefined });
    }
    return { results, model: geminiModel };
  }

  private parseExpansionResult(text: string, query: string, includeLexical: boolean): Queryable[] {
    const lines = text.trim().split("\n");
    const queryables: Queryable[] = lines.map(line => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const type = line.slice(0, colonIdx).trim().toLowerCase();
      if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
      const content = line.slice(colonIdx + 1).trim();
      if (!content) return null;
      return { type: type as QueryType, text: content };
    }).filter((q): q is Queryable => q !== null);

    const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
    if (filtered.length > 0) return filtered;
    return this.fallbackExpansion(query, includeLexical);
  }

  private fallbackExpansion(query: string, includeLexical: boolean): Queryable[] {
    const fallback: Queryable[] = [
      { type: 'vec', text: query },
      { type: 'hyde', text: `Information about ${query}` },
    ];
    if (includeLexical) fallback.unshift({ type: 'lex', text: query });
    return fallback;
  }

  private parsePlainTextExtracts(text: string, maxIndex: number): Array<{ index: number; extract: string }> {
    const results: Array<{ index: number; extract: string }> = [];
    const trimmed = text.trim();
    if (!trimmed || trimmed === "NONE") return results;
    const segments = trimmed.split(/(?=^\[\d+\])/m);
    for (const segment of segments) {
      const match = segment.match(/^\[(\d+)\]\s*([\s\S]*)/);
      if (!match) continue;
      const index = parseInt(match[1]!, 10);
      const extract = match[2]!.trim();
      if (index >= 0 && index < maxIndex && extract.length > 0) {
        results.push({ index, extract });
      }
    }
    return results;
  }

}