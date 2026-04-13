/**
 * llm/fastembed.ts — local ONNX embedding backend via `fastembed-js`.
 *
 * Matches MemPalace's setup: ONNX `all-MiniLM-L6-v2` (384-dim) running
 * locally via onnxruntime-node, no remote API needed. Gives QMD the same
 * "zero setup, no API keys, deterministic" benchmarking capability.
 *
 * Lazy-loaded — `fastembed` is ~110KB but pulls in `onnxruntime-node`,
 * which is a native addon (~80MB with bindings). If the user never calls
 * createFastEmbedBackend() the cost is zero.
 *
 * Model files cache under `~/.cache/qmd/fastembed-models/` (override via
 * `QMD_FASTEMBED_CACHE_DIR`). First-use downloads ~80MB per model.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import type {
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankOptions,
  RerankResult,
  LLM,
} from "./types.js";

// Cached singletons — one per model name. Loading an embedder is slow
// (first call downloads + initializes the ONNX session).
const embedders = new Map<string, Promise<FastEmbedBackend>>();

/**
 * Map from a MemPalace-style / fastembed model identifier to the enum
 * value the fastembed library accepts. We only support the MiniLM model
 * for now — enough to match MemPalace exactly; other BGE models can be
 * added when needed.
 */
function resolveModelEnum(modelName: string, EmbeddingModel: any): unknown {
  const normalized = modelName.toLowerCase();
  if (normalized.includes("minilm") || normalized === "default" || normalized === "all-minilm-l6-v2" || normalized === "fast-all-minilm-l6-v2") {
    return EmbeddingModel.AllMiniLML6V2;
  }
  if (normalized.includes("bge-small-en-v1.5")) return EmbeddingModel.BGESmallENV15;
  if (normalized.includes("bge-base-en-v1.5")) return EmbeddingModel.BGEBaseENV15;
  if (normalized.includes("bge-small-en")) return EmbeddingModel.BGESmallEN;
  if (normalized.includes("bge-base-en")) return EmbeddingModel.BGEBaseEN;
  throw new Error(
    `Unknown fastembed model "${modelName}". Supported: AllMiniLML6V2 (default), BGESmallENV15, BGEBaseENV15, BGESmallEN, BGEBaseEN.`
  );
}

function defaultCacheDir(): string {
  return process.env.QMD_FASTEMBED_CACHE_DIR
    || join(homedir(), ".cache", "qmd", "fastembed-models");
}

/**
 * LLM-shaped wrapper around fastembed-js. Only `embed` and `embedBatch`
 * are implemented; generate/rerank/expandQuery throw. Use this as the
 * embed backend in a hybrid config: RemoteLLM for rerank + queryExpansion,
 * FastEmbedBackend for embeddings.
 */
export class FastEmbedBackend implements Pick<LLM, "embed" | "embedBatch" | "dispose"> {
  private readonly model: string;
  private readonly impl: any; // fastembed.FlagEmbedding — loaded dynamically

  private constructor(model: string, impl: any) {
    this.model = model;
    this.impl = impl;
  }

  static async create(modelName: string = "AllMiniLML6V2"): Promise<FastEmbedBackend> {
    const cached = embedders.get(modelName);
    if (cached) return cached;

    const loading = (async () => {
      // Dynamic import so native onnxruntime isn't loaded on startup.
      const fastembed = await import("fastembed");
      const { FlagEmbedding, EmbeddingModel } = fastembed as any;
      const modelEnum = resolveModelEnum(modelName, EmbeddingModel);
      const cacheDir = defaultCacheDir();
      // fastembed-js tries to mkdir the cache dir but only at the leaf
      // level — if ~/.cache/qmd doesn't exist yet it raises ENOENT. Ensure
      // the full path exists before handing off.
      try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }
      const impl = await FlagEmbedding.init({
        model: modelEnum,
        cacheDir,
        showDownloadProgress: process.env.QMD_FASTEMBED_QUIET !== "on",
      });
      return new FastEmbedBackend(modelName, impl);
    })();

    embedders.set(modelName, loading);
    return loading;
  }

  async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    // fastembed-js distinguishes query vs passage embeddings; MiniLM's
    // same model is used for both. Using queryEmbed for single-input
    // calls gives a vector immediately (no async generator).
    const vec = await this.impl.queryEmbed(text);
    if (!vec || vec.length === 0) return null;
    return { embedding: vec, model: this.model };
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const results: (EmbeddingResult | null)[] = [];
    const gen = this.impl.embed(texts, 32);
    for await (const batch of gen) {
      for (const vec of batch) {
        if (!vec || vec.length === 0) {
          results.push(null);
        } else {
          results.push({ embedding: vec, model: this.model });
        }
      }
    }
    // Safety: ensure length matches input in case the generator dropped items.
    while (results.length < texts.length) results.push(null);
    return results;
  }

  async dispose(): Promise<void> {
    // fastembed-js has no explicit dispose; the onnxruntime session is
    // garbage-collected with the wrapper. Drop the cache entry so a
    // subsequent create() builds a fresh session.
    embedders.delete(this.model);
  }

  // Stubs — FastEmbedBackend is an embed-only provider. Callers that need
  // generate/rerank/expandQuery should hybrid with RemoteLLM.
  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("FastEmbedBackend.generate() not supported — use RemoteLLM or LlamaCpp for generation.");
  }
  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }
  async expandQuery(_query: string, _options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    throw new Error("FastEmbedBackend.expandQuery() not supported.");
  }
  async rerank(_query: string, _documents: RerankDocument[], _options?: RerankOptions): Promise<RerankResult> {
    throw new Error("FastEmbedBackend.rerank() not supported.");
  }
}

/**
 * Convenience factory. Reads `QMD_EMBED_MODEL` or defaults to AllMiniLML6V2.
 */
export function createFastEmbedBackend(model?: string): Promise<FastEmbedBackend> {
  const m = model
    ?? process.env.QMD_FASTEMBED_MODEL
    ?? "AllMiniLML6V2";
  return FastEmbedBackend.create(m);
}
