/**
 * llm/transformers-rerank.ts — local ONNX cross-encoder rerank backend.
 *
 * Cross-encoders score (query, passage) pairs jointly — they're strictly
 * better than bi-encoder cosine for preference-style retrieval because
 * they see both sides of the comparison in a single forward pass.
 * Used as the post-retrieval rerank stage in memoryRecall when
 * `QMD_MEMORY_RERANK=cross-encoder` is set.
 *
 * Default model: `cross-encoder/ms-marco-MiniLM-L6-v2` with quantized
 * file `model_quint8_avx2.onnx`. ~22M params, ~23 MB quantized. Trained on
 * MS MARCO passage ranking — outputs a scalar relevance score per pair,
 * higher is better.
 *
 * Activation:
 *   QMD_MEMORY_RERANK=cross-encoder
 *   QMD_TRANSFORMERS_RERANK_MODEL=cross-encoder/ms-marco-MiniLM-L6-v2  (default)
 *   QMD_TRANSFORMERS_RERANK_FILE=model_quint8_avx2                     (default; no .onnx suffix)
 *   QMD_TRANSFORMERS_RERANK_DTYPE=q8                                   (default)
 *
 * Dedicated env names (vs the embed backend's QMD_TRANSFORMERS_*) to
 * avoid colliding with QMD_RERANK_{MODEL,URL,API_KEY} which are already
 * used by the RemoteLLM rerank provider config (e.g. ZeroEntropy zerank-2).
 *
 * Why this model: MS MARCO MiniLM-L6 is the standard small cross-encoder
 * baseline in 2026. The q8-avx2 quantization is cheap (23 MB, ~5-10 ms
 * per pair on CPU) so we can rerank top-20 candidates in ~100-200 ms
 * without measurable wall-time impact on n=500 LongMemEval runs.
 *
 * Targets the single-session-preference bucket where mxbai-xs q8 hits
 * 90% sr5 vs MemPalace 96.7% — the failure pattern is topically-adjacent
 * but semantically-wrong sessions crowding top-5, which is exactly what
 * cross-encoders fix.
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

// One backend per (modelId, dtype, fileName) — loading is expensive.
const backends = new Map<string, Promise<TransformersRerankBackend>>();

function defaultCacheDir(): string {
  return process.env.QMD_TRANSFORMERS_CACHE_DIR
    || join(homedir(), ".cache", "qmd", "transformers");
}

export class TransformersRerankBackend implements LLM {
  private readonly model: string;
  private readonly classifier: any; // text-classification pipeline — loaded dynamically

  private constructor(model: string, classifier: any) {
    this.model = model;
    this.classifier = classifier;
  }

  get embedModelName(): string {
    return this.model;
  }

  static async create(
    // Default dtype is "fp32" — NOT because we want fp32, but because
    // transformers.js v3 appends `_quantized` to the model_file_name when
    // dtype is a quantized alias (q8/int8/uint8/etc). For explicit file
    // names like `model_quint8_avx2`, we pass dtype="fp32" to suppress
    // the suffix logic and let the explicit file name resolve cleanly.
    // The actual quantization is baked into the file itself.
    modelId: string = "cross-encoder/ms-marco-MiniLM-L6-v2",
    dtype: string = "fp32",
    fileName: string | undefined = "model_quint8_avx2",
  ): Promise<TransformersRerankBackend> {
    const cacheKey = `${modelId}:${dtype}:${fileName ?? ""}`;
    const cached = backends.get(cacheKey);
    if (cached) return cached;

    const loading = (async () => {
      // Dynamic import — transformers.js is heavy.
      const tf = await import("@huggingface/transformers");
      const cacheDir = defaultCacheDir();
      try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

      // transformers.js env knobs — set before pipeline() call, identical
      // to the embed backend's init path.
      (tf as any).env.cacheDir = cacheDir;
      if (process.env.QMD_TRANSFORMERS_QUIET !== "off") {
        (tf as any).env.allowLocalModels = false;
      }

      // transformers.js v3 auto-appends a dtype suffix to model_file_name
      // when dtype is set (q8 → `_quantized`, uint8 → `_uint8`, etc.).
      // Cross-encoder repos that ship pre-quantized files with explicit
      // names (model_quint8_avx2.onnx) need the fileName to resolve
      // verbatim — so we OMIT dtype when a fileName is passed and let
      // transformers.js load the file as-is.
      const opts: Record<string, unknown> = {};
      if (fileName) {
        opts.model_file_name = fileName;
      } else {
        opts.dtype = dtype;
      }
      const classifier = await (tf as any).pipeline("text-classification", modelId, opts);
      return new TransformersRerankBackend(modelId, classifier);
    })();

    backends.set(cacheKey, loading);
    return loading;
  }

  /**
   * Score a (query, documents) batch via the cross-encoder. Returns a
   * RerankResult with one entry per input doc, preserving original order
   * via `index`. Higher `score` = more relevant.
   *
   * ms-marco cross-encoders output a single scalar logit per pair. When
   * fed through transformers.js pipeline("text-classification"), the
   * output is an array of {label, score} where the scalar lives under
   * .score (the single-class head). We return that directly.
   */
  async rerank(
    query: string,
    documents: RerankDocument[],
    _options?: RerankOptions,
  ): Promise<RerankResult> {
    if (documents.length === 0) {
      return { results: [], model: this.model };
    }
    // transformers.js text-classification pipeline accepts an array of
    // {text, text_pair} objects for cross-encoder-style pair input.
    const pairs = documents.map(d => ({ text: query, text_pair: d.text }));
    const output = await this.classifier(pairs, { top_k: 1 });
    // Output shape: either an array of {label, score} per pair, or an
    // array of arrays (when top_k > 1). Normalize to one score per pair.
    const rows: Array<{ label?: string; score?: number }> = Array.isArray(output?.[0])
      ? output.map((a: any[]) => a[0] ?? {})
      : (output as Array<any>);
    const results = documents.map((doc, i) => ({
      file: doc.file,
      score: typeof rows[i]?.score === "number" ? (rows[i]!.score as number) : 0,
      index: i,
    }));
    return { results, model: this.model };
  }

  async dispose(): Promise<void> {
    for (const key of backends.keys()) {
      if (key.startsWith(this.model + ":")) backends.delete(key);
    }
  }

  // Rerank-only backend. Stubs so the LLM type is partially satisfied.
  async embed(_text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    throw new Error("TransformersRerankBackend.embed() not supported.");
  }
  async embedBatch(_texts: string[], _options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    throw new Error("TransformersRerankBackend.embedBatch() not supported.");
  }
  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("TransformersRerankBackend.generate() not supported.");
  }
  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }
  async expandQuery(_query: string, _options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    throw new Error("TransformersRerankBackend.expandQuery() not supported.");
  }
}

/**
 * Parse a HuggingFace-style model path like
 *   "cross-encoder/ms-marco-MiniLM-L6-v2/onnx/model_quint8_avx2"
 * into { modelId, fileName }. The optional `onnx/` subfolder is allowed
 * but stripped — transformers.js auto-prefixes it for ONNX loads. If the
 * path has no file segment, only modelId is returned.
 *
 * Examples:
 *   "owner/repo"                            → { modelId: "owner/repo" }
 *   "owner/repo/onnx/model_q8_avx2"         → { modelId: "owner/repo", fileName: "model_q8_avx2" }
 *   "owner/repo/model_q8_avx2"              → { modelId: "owner/repo", fileName: "model_q8_avx2" }
 */
export function parseHfModelPath(path: string): { modelId: string; fileName?: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return { modelId: path };
  // First two segments are always owner/repo for HF.
  const modelId = `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return { modelId };
  // Strip optional onnx/ subfolder hint — transformers.js handles it.
  const tail = parts.slice(2).filter(p => p !== "onnx");
  if (tail.length === 0) return { modelId };
  // Strip .onnx extension if present so it's a clean file stem.
  const fileName = tail.join("/").replace(/\.onnx$/, "");
  return { modelId, fileName };
}

/**
 * Convenience factory. Reads env vars or uses the 2026-04-14 defaults
 * (ms-marco-MiniLM-L6-v2 + model_quint8_avx2). Dedicated env knobs
 * avoid collision with QMD_RERANK_MODEL which is used by RemoteLLM for
 * remote rerank providers (e.g. ZeroEntropy zerank-2).
 *
 *   QMD_TRANSFORMERS_RERANK        — composite HF path, e.g.
 *                                    cross-encoder/ms-marco-MiniLM-L6-v2/onnx/model_quint8_avx2
 *                                    (overrides the three vars below if set)
 *   QMD_TRANSFORMERS_RERANK_MODEL  — HF repo id
 *   QMD_TRANSFORMERS_RERANK_FILE   — ONNX file name without .onnx suffix
 *   QMD_TRANSFORMERS_RERANK_DTYPE  — q8 | fp16 | fp32 | q4 | int8 | uint8
 */
export function createTransformersRerankBackend(
  model?: string,
  dtype?: string,
  fileName?: string,
): Promise<TransformersRerankBackend> {
  // Composite override takes precedence over the three individual vars.
  const composite = process.env.QMD_TRANSFORMERS_RERANK;
  let envModel: string | undefined;
  let envFile: string | undefined;
  if (composite) {
    const parsed = parseHfModelPath(composite);
    envModel = parsed.modelId;
    envFile = parsed.fileName;
  }
  const m = model
    ?? envModel
    ?? process.env.QMD_TRANSFORMERS_RERANK_MODEL
    ?? "cross-encoder/ms-marco-MiniLM-L6-v2";
  const d = dtype
    ?? process.env.QMD_TRANSFORMERS_RERANK_DTYPE
    ?? "fp32";
  const f = fileName
    ?? envFile
    ?? process.env.QMD_TRANSFORMERS_RERANK_FILE
    ?? "model_quint8_avx2";
  return TransformersRerankBackend.create(m, d, f);
}
