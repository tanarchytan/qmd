/**
 * llm/transformers-embed.ts — local ONNX embedding backend via
 * `@huggingface/transformers` (the rebranded `@xenova/transformers`).
 *
 * Accepts ANY HuggingFace repo that ships an ONNX export — usually under the
 * `onnx-community/<name>-ONNX` org or an `onnx/` subfolder in the main repo.
 *
 * Lazy-loaded. Dynamic import means `@huggingface/transformers` only
 * materializes when a user opts in via `LOTL_EMBED_BACKEND=transformers`.
 *
 * Model files cache under `~/.cache/lotl/transformers/` (override via
 * `LOTL_TRANSFORMERS_CACHE_DIR`). First use downloads ~150–600 MB depending
 * on the chosen dtype.
 *
 * Activation:
 *   LOTL_EMBED_BACKEND=transformers
 *   LOTL_TRANSFORMERS_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1   (default)
 *   LOTL_TRANSFORMERS_DTYPE=q8                                     (default; q8 | fp16 | fp32 | q4 | int8 | uint8)
 *   LOTL_TRANSFORMERS_FILE=                                        (optional override, e.g. model_quint8_avx2)
 *   LOTL_TRANSFORMERS_DEVICE=cpu                                   (default; cpu | webgpu | dml | auto). On Node.js only cpu/webgpu/dml are valid device IDs.
 *                                                                 `auto` probes GPU capabilities + model size and picks the best combination
 *                                                                 (see `embed-sizer.ts` — also sets LOTL_EMBED_MICROBATCH and LOTL_EMBED_MAX_WORKERS).
 *                                                                 WebGPU unblocks models that OOM on CPU (e.g. embgemma-300m via fp32 external-data expansion).
 *                                                                 Benchmarked 2026-04-17: CPU q8 is fastest for small+medium models (22M–335M);
 *                                                                 WebGPU only wins when CPU won't fit. DML was worse than CPU on AMD iGPU.
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

/** Map model id → (queryPrefix, passagePrefix). Covers the families in Phase 11.7
 * that require task-specific prefixes at embed time. Unknown models fall through
 * to env-var overrides → empty strings (no prefix). */
const KNOWN_PREFIX_FAMILIES: Array<{ pattern: RegExp; query: string; passage: string }> = [
  // intfloat E5 family — "query:" / "passage:" (trailing space included in the prefix).
  { pattern: /(^|\/)e5-(small|base|large)(-v\d)?(-unsupervised)?$/i, query: "query: ", passage: "passage: " },
  { pattern: /(^|\/)(xenova\/)?e5-/i, query: "query: ", passage: "passage: " },
  { pattern: /multilingual-e5/i, query: "query: ", passage: "passage: " },
  // Nomic — "search_query:" / "search_document:".
  { pattern: /nomic-embed-text/i, query: "search_query: ", passage: "search_document: " },
  // BGE-instruct / bge-*-instruct — same "query:" / "passage:" shape.
  { pattern: /bge.*-instruct/i, query: "query: ", passage: "passage: " },
  // Jina v3/v5 (if they ever become usable in transformers.js) — "Query: " / "Passage: ".
  { pattern: /jina-embeddings-v[35]/i, query: "Query: ", passage: "Passage: " },
];

/** Resolve the query/passage prefix for a model.
 *  Priority: env override → known family auto-detect → empty (no prefix). */
function resolveEmbedPrefix(model: string, isQuery: boolean): string {
  const envKey = isQuery ? "LOTL_EMBED_QUERY_PREFIX" : "LOTL_EMBED_PASSAGE_PREFIX";
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined) return fromEnv; // Allow explicit empty-string to disable auto-detect.
  for (const fam of KNOWN_PREFIX_FAMILIES) {
    if (fam.pattern.test(model)) return isQuery ? fam.query : fam.passage;
  }
  return "";
}

function defaultCacheDir(): string {
  return process.env.LOTL_TRANSFORMERS_CACHE_DIR
    || join(homedir(), ".cache", "lotl", "transformers");
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
    device?: string,
  ): Promise<TransformersEmbedBackend> {
    const cacheKey = `${modelId}:${dtype}:${fileName ?? ""}:${device ?? ""}`;
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
      if (process.env.LOTL_TRANSFORMERS_QUIET !== "off") {
        (tf as any).env.allowLocalModels = false;
      }

      const opts: Record<string, unknown> = { dtype };
      if (fileName) opts.model_file_name = fileName;
      if (device) opts.device = device;
      const extractor = await (tf as any).pipeline("feature-extraction", modelId, opts);
      return new TransformersEmbedBackend(modelId, extractor);
    })();

    extractors.set(cacheKey, loading);
    return loading;
  }

  /** Apply query/passage prefix required by E5, Nomic, BGE-instruct etc.
   * Prefixes come from env vars (`LOTL_EMBED_QUERY_PREFIX`, `LOTL_EMBED_PASSAGE_PREFIX`),
   * or are auto-detected from the model id for well-known families.
   * No prefix → returns text unchanged. */
  private withPrefix(text: string, isQuery: boolean): string {
    const prefix = resolveEmbedPrefix(this.model, isQuery);
    return prefix ? `${prefix}${text}` : text;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const formatted = this.withPrefix(text, options?.isQuery === true);
    const out = await this.extractor(formatted, { pooling: "mean", normalize: true });
    // `out.data` is a Float32Array of shape [1, dim] — flatten to number[].
    const vec = Array.from(out.data as Float32Array);
    if (vec.length === 0) return null;
    return { embedding: vec, model: this.model };
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const formatted = texts.map(t => this.withPrefix(t, options?.isQuery === true));
    // Batch feature-extraction returns a tensor of shape [batch, dim].
    const out = await this.extractor(formatted, { pooling: "mean", normalize: true });
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
 *   LOTL_TRANSFORMERS_EMBED — composite HF path, e.g.
 *     mixedbread-ai/mxbai-embed-xsmall-v1
 *     mixedbread-ai/mxbai-embed-xsmall-v1/onnx/model_q8
 *     sentence-transformers/all-MiniLM-L6-v2/onnx/model_quint8_avx2
 *   (parsed into modelId + optional fileName via parseHfModelPath)
 *
 * OR the explicit triple:
 *   LOTL_TRANSFORMERS_MODEL  — HF repo id
 *   LOTL_TRANSFORMERS_DTYPE  — q8 | fp16 | fp32 | q4 | int8 | uint8
 *   LOTL_TRANSFORMERS_FILE   — ONNX file stem (omit .onnx suffix)
 *
 * The composite var takes precedence when set.
 */
export async function createTransformersEmbedBackend(
  model?: string,
  dtype?: string,
  fileName?: string,
  device?: string,
): Promise<TransformersEmbedBackend> {
  // Opt-in direct-ORT path for models whose `model_type` is not registered
  // in transformers.js's feature-extraction pipeline dispatcher
  // (e.g. jina_embeddings_v5, eurobert, nomic_bert, NewModel).
  // Returns the same structural LLM shape — consumers type it as `any`.
  if (process.env.LOTL_EMBED_DIRECT === "on") {
    const { createTransformersEmbedDirectBackend } = await import("./transformers-embed-direct.js");
    return (await createTransformersEmbedDirectBackend()) as unknown as TransformersEmbedBackend;
  }

  // Composite override (parseHfModelPath lives in transformers-rerank.ts
  // — re-export there so both backends share the parser).
  const composite = process.env.LOTL_TRANSFORMERS_EMBED;
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
    ?? process.env.LOTL_TRANSFORMERS_MODEL
    ?? "mixedbread-ai/mxbai-embed-xsmall-v1";
  const d = dtype
    ?? process.env.LOTL_TRANSFORMERS_DTYPE
    ?? "q8";
  const f = fileName
    ?? envFile
    ?? process.env.LOTL_TRANSFORMERS_FILE;
  let dev = device ?? process.env.LOTL_TRANSFORMERS_DEVICE;

  // Accept the friendlier alias `gpu` and route it through the same GPU path on
  // every platform (webgpu is the only GPU device transformers.js accepts in Node).
  if (dev === "gpu") dev = "webgpu";

  if (dev === "auto") {
    const { computeEmbedBudget, formatBudget } = await import("./embed-sizer.js");
    const { probeGpu } = await import("./gpu-probe.js");
    const [caps, budget] = await Promise.all([probeGpu(), computeEmbedBudget(m, d)]);
    const quiet = process.env.LOTL_TRANSFORMERS_QUIET === "on";
    if (!quiet) {
      for (const w of caps.warnings ?? []) process.stderr.write(`[qmd.embed] warning: ${w}\n`);
      process.stderr.write(`[qmd.embed] auto-selected: ${formatBudget(budget)}\n`);
    }
    dev = budget.device;
    // Export the sized microbatch + worker count so eval harnesses and the
    // memory ingest path can honor them without running the probe twice.
    if (!process.env.LOTL_EMBED_MICROBATCH) {
      process.env.LOTL_EMBED_MICROBATCH = String(budget.microbatch);
    }
    if (!process.env.LOTL_EMBED_MAX_WORKERS) {
      process.env.LOTL_EMBED_MAX_WORKERS = String(budget.maxWorkers);
    }
  }

  return TransformersEmbedBackend.create(m, d, f, dev);
}
