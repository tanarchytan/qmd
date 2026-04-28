/**
 * llm/transformers-embed-direct.ts — direct-ORT embed backend for models
 * whose `model_type` is not registered in `@huggingface/transformers`'s
 * `feature-extraction` pipeline dispatcher (e.g. jina_embeddings_v5,
 * eurobert, nomic_bert, NewModel).
 *
 * The ONNX graph itself is self-contained — the dispatcher block is a JS-side
 * registry guard, not an ORT limitation. We bypass the pipeline by:
 *   1. Loading the tokenizer via `AutoTokenizer` (dispatched by tokenizer_class,
 *      independent of model_type).
 *   2. Fetching the ONNX file (and optional `.onnx_data` external weights blob)
 *      straight from HuggingFace Hub into the same local cache dir.
 *   3. Running inference via `onnxruntime-node`'s `InferenceSession`.
 *   4. Applying last-token / cls / mean pooling + L2 normalize manually.
 *
 * Activation:
 *   LOTL_EMBED_BACKEND=transformers
 *   LOTL_EMBED_DIRECT=on
 *   LOTL_TRANSFORMERS_MODEL=jinaai/jina-embeddings-v5-text-nano-retrieval  (default)
 *   LOTL_TRANSFORMERS_DIRECT_VARIANT=model_quantized                       (default; model|model_fp16|model_q4|model_q4f16|model_quantized)
 *   LOTL_TRANSFORMERS_DIRECT_POOLING=last                                  (default; last|mean|cls)
 *
 * Last-token pooling uses `padding_side="left"` so the final token is at
 * position `seq_len-1` for every row in the batch.
 */

import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync, existsSync, createWriteStream } from "fs";
import { pipeline as streamPipeline } from "stream/promises";
import { createRequire } from "module";

// onnxruntime-node ships under @huggingface/transformers/node_modules — it is a
// transitive dep of transformers, not a direct lotl dep. We resolve it via a
// createRequire rooted at the transformers package's main entry so we don't need
// to add it to package.json or rely on hoisting. The package's exports field
// does not expose ./package.json, so we walk up from the resolved main entry.
function loadOnnxRuntime(): any {
  const req = createRequire(import.meta.url);
  const tfMain = req.resolve("@huggingface/transformers");
  // tfMain is e.g. .../node_modules/@huggingface/transformers/dist/transformers.node.mjs
  // Walk up until the parent dir has a node_modules/onnxruntime-node folder.
  let dir = dirname(tfMain);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "node_modules", "onnxruntime-node"))) {
      const reqFromTf = createRequire(join(dir, "package.json.x")); // dummy filename — only the dir matters
      return reqFromTf("onnxruntime-node");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort — try top-level resolution.
  return req("onnxruntime-node");
}
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

type Pooling = "last" | "mean" | "cls";

const sessions = new Map<string, Promise<TransformersEmbedDirectBackend>>();

function defaultCacheDir(): string {
  return process.env.LOTL_TRANSFORMERS_CACHE_DIR
    || join(homedir(), ".cache", "lotl", "transformers-direct");
}

async function downloadToFile(url: string, dest: string, quiet: boolean): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF download ${res.status} ${res.statusText}: ${url}`);
  if (!res.body) throw new Error(`HF download empty body: ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  if (!quiet) process.stderr.write(`[lotl.embed-direct] fetching ${url}\n`);
  const out = createWriteStream(dest);
  await streamPipeline(res.body as any, out);
}

async function ensureOnnxCached(
  modelId: string,
  variant: string,
  cacheDir: string,
  quiet: boolean,
): Promise<string> {
  const safe = modelId.replace(/\//g, "--");
  const dir = join(cacheDir, safe, "onnx");
  mkdirSync(dir, { recursive: true });
  const onnxFile = join(dir, `${variant}.onnx`);
  const dataFile = join(dir, `${variant}.onnx_data`);
  const baseUrl = `https://huggingface.co/${modelId}/resolve/main/onnx`;
  if (!existsSync(onnxFile)) {
    await downloadToFile(`${baseUrl}/${variant}.onnx`, onnxFile, quiet);
  }
  // External-data sidecar is model-dependent. 404 = model inlines everything, which is fine.
  if (!existsSync(dataFile)) {
    try {
      await downloadToFile(`${baseUrl}/${variant}.onnx_data`, dataFile, quiet);
    } catch {
      if (!quiet) process.stderr.write(`[lotl.embed-direct] no external data for ${variant} (ok if inline)\n`);
    }
  }
  return onnxFile;
}

export class TransformersEmbedDirectBackend implements LLM {
  private readonly model: string;
  private readonly session: any;
  private readonly tokenizer: any;
  private readonly outputName: string;
  private readonly pooling: Pooling;
  private readonly Tensor: any;

  private constructor(
    model: string,
    session: any,
    tokenizer: any,
    outputName: string,
    pooling: Pooling,
    Tensor: any,
  ) {
    this.model = model;
    this.session = session;
    this.tokenizer = tokenizer;
    this.outputName = outputName;
    this.pooling = pooling;
    this.Tensor = Tensor;
  }

  get embedModelName(): string {
    return this.model;
  }

  static async create(
    modelId: string,
    variant: string = "model_quantized",
    pooling: Pooling = "last",
  ): Promise<TransformersEmbedDirectBackend> {
    const cacheKey = `${modelId}:${variant}:${pooling}`;
    const cached = sessions.get(cacheKey);
    if (cached) return cached;

    const loading = (async () => {
      const quiet = true; // Hardcoded quiet-by-default; env knob removed 2026-04-21.
      const cacheDir = defaultCacheDir();
      try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

      const tf = await import("@huggingface/transformers");
      const ort = loadOnnxRuntime();

      (tf as any).env.cacheDir = cacheDir;

      // Tokenizer dispatch uses `tokenizer_class` in tokenizer_config.json — independent
      // of the `model_type` dispatch that blocks the feature-extraction pipeline.
      const tokenizer = await (tf as any).AutoTokenizer.from_pretrained(modelId);
      if (pooling === "last") {
        // Last-token pool needs left-padding so the terminal token sits at seq_len-1
        // for every row (otherwise padding tokens would be at the tail on right-padded rows).
        try { tokenizer.padding_side = "left"; } catch { /* some versions readonly; fall back via encoded opts */ }
      }

      const onnxPath = await ensureOnnxCached(modelId, variant, cacheDir, quiet);
      const session = await (ort as any).InferenceSession.create(onnxPath, {
        executionProviders: ["cpu"],
      });
      const outputName = (session.outputNames[0]) as string;
      if (!quiet) {
        process.stderr.write(
          `[lotl.embed-direct] loaded ${modelId}/${variant} pool=${pooling} output=${outputName} inputs=${session.inputNames.join(",")}\n`,
        );
      }
      return new TransformersEmbedDirectBackend(modelId, session, tokenizer, outputName, pooling, (ort as any).Tensor);
    })();

    sessions.set(cacheKey, loading);
    return loading;
  }

  private toBigInt64(arr: any): BigInt64Array {
    if (arr instanceof BigInt64Array) return arr;
    const out = new BigInt64Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = BigInt(Number(arr[i]));
    return out;
  }

  private pool(hidden: any, attentionMask: any): number[][] {
    const dims = hidden.dims as number[];
    const data = hidden.data as Float32Array;
    const results: number[][] = [];

    if (dims.length === 2) {
      const b = dims[0]!;
      const h = dims[1]!;
      for (let i = 0; i < b; i++) {
        results.push(Array.from(data.slice(i * h, (i + 1) * h)));
      }
      return results;
    }
    if (dims.length !== 3) {
      throw new Error(`Unexpected output rank ${dims.length} from direct ORT`);
    }
    const b = dims[0]!;
    const s = dims[1]!;
    const h = dims[2]!;
    const mask = Array.from(attentionMask.data as any).map((v: any) => Number(v));

    for (let i = 0; i < b; i++) {
      if (this.pooling === "cls") {
        const start = i * s * h;
        results.push(Array.from(data.slice(start, start + h)));
      } else if (this.pooling === "last") {
        // Left-padded → last token uniformly at s-1. For right-padded tokenizers that
        // refused the padding_side setter, fall back to the last unmasked index.
        let idx = s - 1;
        if (mask[i * s + idx] === 0) {
          for (let t = s - 1; t >= 0; t--) if (mask[i * s + t] === 1) { idx = t; break; }
        }
        const start = i * s * h + idx * h;
        results.push(Array.from(data.slice(start, start + h)));
      } else {
        // Mean over masked tokens.
        let denom = 0;
        const vec = new Array<number>(h).fill(0);
        for (let t = 0; t < s; t++) {
          if (!mask[i * s + t]) continue;
          denom++;
          const off = i * s * h + t * h;
          for (let d = 0; d < h; d++) vec[d]! += data[off + d]!;
        }
        if (denom === 0) denom = 1;
        for (let d = 0; d < h; d++) vec[d]! /= denom;
        results.push(vec);
      }
    }
    return results;
  }

  private l2(v: number[]): number[] {
    let s = 0;
    for (const x of v) s += x * x;
    const n = Math.sqrt(s) || 1;
    return v.map(x => x / n);
  }

  private async runForward(texts: string[]): Promise<number[][]> {
    // Cap seq_len aggressively. EuroBERT supports 8192 but padding to that
    // uniformly produces ~800 MB hidden_states per batch (32 × 8192 × 768 × 4),
    // which exhausts RAM after a few hundred calls. Memory text for LME/LoCoMo
    // is <2K tokens per row; 1024 is a safe cap with minimal quality loss.
    // Override via LOTL_TRANSFORMERS_DIRECT_MAXLEN if needed.
    const maxLen = 1024; // Hardcoded (post-Phase-11.7 default); env knob removed 2026-04-21.
    const encoded = await this.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: maxLen,
    });
    const dimsIn = encoded.input_ids.dims as number[];
    const batch = dimsIn[0]!;
    const seqLen = dimsIn[1]!;
    const inputIds = this.toBigInt64(encoded.input_ids.data);
    const attentionMask = this.toBigInt64(encoded.attention_mask.data);

    const feeds: Record<string, any> = {
      input_ids: new this.Tensor("int64", inputIds, [batch, seqLen]),
      attention_mask: new this.Tensor("int64", attentionMask, [batch, seqLen]),
    };
    // Some exports also require token_type_ids — default zeros.
    if ((this.session.inputNames as string[]).includes("token_type_ids")) {
      feeds.token_type_ids = new this.Tensor("int64", new BigInt64Array(batch * seqLen), [batch, seqLen]);
    }

    const outputs = await this.session.run(feeds);
    const hidden = outputs[this.outputName];
    const pooled = this.pool(hidden, encoded.attention_mask);
    return pooled.map(v => this.l2(v));
  }

  async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const [vec] = await this.runForward([text]);
    return vec && vec.length > 0 ? { embedding: vec, model: this.model } : null;
  }

  async embedBatch(texts: string[], _options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const vecs = await this.runForward(texts);
    return vecs.map(v => (v && v.length > 0 ? { embedding: v, model: this.model } : null));
  }

  async dispose(): Promise<void> {
    try { await this.session.release?.(); } catch { /* noop */ }
    for (const key of Array.from(sessions.keys())) {
      if (key.startsWith(this.model + ":")) sessions.delete(key);
    }
  }

  async generate(_p: string, _o?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("TransformersEmbedDirectBackend.generate() not supported.");
  }
  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }
  async expandQuery(_q: string, _o?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    throw new Error("TransformersEmbedDirectBackend.expandQuery() not supported.");
  }
  async rerank(_q: string, _d: RerankDocument[], _o?: RerankOptions): Promise<RerankResult> {
    throw new Error("TransformersEmbedDirectBackend.rerank() not supported.");
  }
}

export async function createTransformersEmbedDirectBackend(
  model?: string,
  variant?: string,
  pooling?: Pooling,
): Promise<TransformersEmbedDirectBackend> {
  const m = model
    ?? process.env.LOTL_TRANSFORMERS_MODEL
    ?? "jinaai/jina-embeddings-v5-text-nano-retrieval";
  const v = variant
    ?? process.env.LOTL_TRANSFORMERS_DIRECT_VARIANT
    ?? "model_quantized";
  const pRaw = pooling ?? (process.env.LOTL_TRANSFORMERS_DIRECT_POOLING as Pooling | undefined);
  const p: Pooling = pRaw === "mean" || pRaw === "cls" ? pRaw : "last";
  return TransformersEmbedDirectBackend.create(m, v, p);
}
