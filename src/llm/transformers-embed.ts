/**
 * llm/transformers-embed.ts — local ONNX embedding backend via
 * `@huggingface/transformers` (the rebranded `@xenova/transformers`).
 *
 * Accepts ANY HuggingFace repo that ships an ONNX export — usually under the
 * `onnx-community/<name>-ONNX` org or an `onnx/` subfolder in the main repo.
 *
 * Lazy-loaded. Dynamic import means `@huggingface/transformers` only
 * materializes when a user opts in via `QMD_EMBED_BACKEND=transformers`.
 *
 * Model files cache under `~/.cache/qmd/transformers/` (override via
 * `QMD_TRANSFORMERS_CACHE_DIR`). First use downloads ~150–600 MB depending
 * on the chosen dtype.
 *
 * Activation:
 *   QMD_EMBED_BACKEND=transformers
 *   QMD_TRANSFORMERS_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1   (default)
 *   QMD_TRANSFORMERS_DTYPE=q8                                     (default; q8 | fp16 | fp32 | q4 | int8 | uint8)
 *   QMD_TRANSFORMERS_FILE=                                        (optional override, e.g. model_quint8_avx2)
 *
 * Default = mxbai-xsmall q8: chosen as production default after the
 * 2026-04-13 LME _s n=500 A/B (94.2% R@5, 14m49s — 37% faster than the
 * fp32 MiniLM baseline at 93.2% R@5 / 23m33s). If this backend fails to load,
 * memory embed returns null and recall falls back to FTS-only (no other
 * local backend exists post-cleanup).
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

// One extractor per (modelId, dtype) — loading a pipeline is expensive.
const extractors = new Map<string, Promise<TransformersEmbedBackend>>();

function defaultCacheDir(): string {
  return process.env.QMD_TRANSFORMERS_CACHE_DIR
    || join(homedir(), ".cache", "qmd", "transformers");
}

export class TransformersEmbedBackend implements LLM {
  private readonly model: string;
  private readonly extractor: any; // feature-extraction pipeline — loaded dynamically

  private constructor(model: string, extractor: any) {
    this.model = model;
    this.extractor = extractor;
  }

  /** Embed model identifier — used by the document collection reindex path
   * to format query/passage prefixes correctly per model family. */
  get embedModelName(): string {
    return this.model;
  }

  static async create(
    modelId: string = "mixedbread-ai/mxbai-embed-xsmall-v1",
    dtype: string = "q8",
    fileName?: string,
  ): Promise<TransformersEmbedBackend> {
    const cacheKey = `${modelId}:${dtype}:${fileName ?? ""}`;
    const cached = extractors.get(cacheKey);
    if (cached) return cached;

    const loading = (async () => {
      // Dynamic import — `@huggingface/transformers` pulls in sharp (~30 MB)
      // and onnxruntime-web. We only want that cost when opted in.
      const tf = await import("@huggingface/transformers");
      const cacheDir = defaultCacheDir();
      try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

      // transformers.js env knobs — set before pipeline() call.
      (tf as any).env.cacheDir = cacheDir;
      if (process.env.QMD_TRANSFORMERS_QUIET !== "off") {
        (tf as any).env.allowLocalModels = false;
      }

      const opts: Record<string, unknown> = { dtype };
      if (fileName) opts.model_file_name = fileName;
      const extractor = await (tf as any).pipeline("feature-extraction", modelId, opts);
      return new TransformersEmbedBackend(modelId, extractor);
    })();

    extractors.set(cacheKey, loading);
    return loading;
  }

  async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const out = await this.extractor(text, { pooling: "mean", normalize: true });
    // `out.data` is a Float32Array of shape [1, dim] — flatten to number[].
    const vec = Array.from(out.data as Float32Array);
    if (vec.length === 0) return null;
    return { embedding: vec, model: this.model };
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    // Batch feature-extraction returns a tensor of shape [batch, dim].
    const out = await this.extractor(texts, { pooling: "mean", normalize: true });
    // Prefer .tolist() when available (transformers.js >= v3).
    let rows: number[][];
    if (typeof (out as any).tolist === "function") {
      rows = (out as any).tolist();
    } else {
      // Fallback: slice flat data by dim.
      const [_batch, dim] = (out as any).dims ?? [texts.length, (out as any).data.length / texts.length];
      const flat = Array.from((out as any).data as Float32Array);
      rows = [];
      for (let i = 0; i < texts.length; i++) rows.push(flat.slice(i * dim, (i + 1) * dim));
    }
    return rows.map((vec) => (vec.length === 0 ? null : { embedding: vec, model: this.model }));
  }

  async dispose(): Promise<void> {
    // transformers.js has no explicit dispose; extractor + ORT session are
    // GC'd when the cache entry drops. Clear both buckets for this model.
    for (const key of extractors.keys()) {
      if (key.startsWith(this.model + ":")) extractors.delete(key);
    }
  }

  // Embed-only backend. Stubs so the LLM type is partially satisfied.
  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("TransformersEmbedBackend.generate() not supported.");
  }
  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }
  async expandQuery(_query: string, _options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    throw new Error("TransformersEmbedBackend.expandQuery() not supported.");
  }
  async rerank(_query: string, _documents: RerankDocument[], _options?: RerankOptions): Promise<RerankResult> {
    throw new Error("TransformersEmbedBackend.rerank() not supported.");
  }
}

/**
 * Convenience factory. Reads env vars or defaults.
 *
 * Two ways to specify the model:
 *
 *   QMD_TRANSFORMERS_EMBED — composite HF path, e.g.
 *     mixedbread-ai/mxbai-embed-xsmall-v1
 *     mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q8
 *     sentence-transformers/all-MiniLM-L6-v2/onnx/model_quint8_avx2
 *   (parsed into modelId + optional fileName via parseHfModelPath)
 *
 * OR the explicit triple:
 *   QMD_TRANSFORMERS_MODEL  — HF repo id
 *   QMD_TRANSFORMERS_DTYPE  — q8 | fp16 | fp32 | q4 | int8 | uint8
 *   QMD_TRANSFORMERS_FILE   — ONNX file stem (omit .onnx suffix)
 *
 * The composite var takes precedence when set.
 */
export function createTransformersEmbedBackend(
  model?: string,
  dtype?: string,
  fileName?: string,
): Promise<TransformersEmbedBackend> {
  // Composite override (parseHfModelPath lives in transformers-rerank.ts
  // — re-export there so both backends share the parser).
  const composite = process.env.QMD_TRANSFORMERS_EMBED;
  let envModel: string | undefined;
  let envFile: string | undefined;
  if (composite) {
    // Inline parser to avoid a circular import. Same logic as
    // parseHfModelPath in transformers-rerank.ts.
    const parts = composite.split("/").filter(Boolean);
    if (parts.length >= 2) {
      envModel = `${parts[0]}/${parts[1]}`;
      const tail = parts.slice(2).filter(p => p !== "onnx");
      if (tail.length > 0) envFile = tail.join("/").replace(/\.onnx$/, "");
    } else {
      envModel = composite;
    }
  }
  const m = model
    ?? envModel
    ?? process.env.QMD_TRANSFORMERS_MODEL
    ?? "mixedbread-ai/mxbai-embed-xsmall-v1";
  const d = dtype
    ?? process.env.QMD_TRANSFORMERS_DTYPE
    ?? "q8";
  const f = fileName
    ?? envFile
    ?? process.env.QMD_TRANSFORMERS_FILE;
  return TransformersEmbedBackend.create(m, d, f);
}
