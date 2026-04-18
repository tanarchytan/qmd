/**
 * llm/embed-sizer.ts — pick device + microbatch + worker count from GPU capabilities
 * and model config.
 *
 * Formula (derived empirically from the 2026-04-17 embgemma-300m WebGPU probe that
 * OOM'd at batch=45×seq=2048):
 *
 *   attention_matrix_bytes = heads × seq² × attn_dtype_bytes × microbatch
 *   safe_microbatch = floor((maxBufferSize × 0.70) / (heads × seq² × 4))   // fp32 safety assumption
 *
 *   model_footprint = model_file_bytes × 2                                  // weights + working set
 *   activation_footprint = microbatch × seq × dim × 4 × layers × 2
 *   max_workers = floor((vram_bytes × 0.80) / (model_footprint + activation_footprint))
 *
 * Config lookups: fetch `config.json` from the HuggingFace repo once (cached),
 * read hidden_size / num_attention_heads / num_hidden_layers / max_position_embeddings.
 * ONNX file size: HEAD the `.onnx` file in the `onnx/` folder (or model.onnx root).
 */
import { probeGpu, type GpuCapabilities } from "./gpu-probe.js";

export interface EmbedBudget {
  device: "cpu" | "webgpu" | "dml";
  dtype: string;
  microbatch: number;
  maxWorkers: number;
  reason: string;
}

export interface SizerOptions {
  /** User-provided seq length hint (clamps the model's default if lower). */
  maxSeqLen?: number;
  /** VRAM headroom fraction. Default 0.80. */
  vramHeadroom?: number;
  /** Buffer headroom fraction. Default 0.70 (attention peaks higher than average). */
  bufferHeadroom?: number;
}

/**
 * Pick a good device/microbatch/workers tuple for a given model + dtype.
 *
 * GPU-first decision tree (can be inverted via opts or LOTL_TRANSFORMERS_AUTO_PREFER=cpu):
 *   1. GPU available + model fits the per-buffer limit → webgpu
 *   2. GPU unavailable OR model overruns the per-buffer limit → cpu fallback
 *   3. Always surface probe warnings (driver age, missing stack, iGPU hints) on caller's log
 */
export async function computeEmbedBudget(
  modelId: string,
  dtype: string,
  opts: SizerOptions = {},
): Promise<EmbedBudget> {
  const caps = await probeGpu();
  const cfg = await fetchModelConfig(modelId);
  const fileBytes = await fetchModelOnnxSize(modelId, dtype);

  const vramHeadroom = opts.vramHeadroom ?? 0.80;
  const bufferHeadroom = opts.bufferHeadroom ?? 0.70;
  const preferCpu = process.env.LOTL_TRANSFORMERS_AUTO_PREFER === "cpu";

  const cpuThreads = Math.max(1, (await import("os")).cpus().length - 1);
  const cpuBudget = (reason: string): EmbedBudget => ({
    device: "cpu",
    dtype,
    microbatch: 8,
    maxWorkers: Math.min(4, cpuThreads),
    reason,
  });

  // No GPU available → CPU fallback.
  if (!caps.available) {
    return cpuBudget("CPU chosen: no WebGPU adapter available (check driver install)");
  }

  // Environment asked for CPU preference.
  if (preferCpu) {
    return cpuBudget(`CPU chosen: LOTL_TRANSFORMERS_AUTO_PREFER=cpu`);
  }

  // Compute safe microbatch from maxBufferSize. If ≥1, GPU path is viable.
  const seq = Math.min(cfg.maxSeqLen, opts.maxSeqLen ?? cfg.maxSeqLen);
  const heads = cfg.numHeads;
  const maxBuffer = caps.maxBufferSize ?? 2 * 2 ** 30;
  const attentionPerExample = heads * seq * seq * 4; // fp32 attention matrix worst case
  const microbatch = Math.floor((maxBuffer * bufferHeadroom) / attentionPerExample);

  // If even microbatch=1 overruns the buffer cap, GPU can't run this seq length.
  // Fall back to CPU — there's no tiny-enough inference on WebGPU for this geometry.
  if (microbatch < 1) {
    return cpuBudget(
      `CPU chosen: model attention matrix (${heads}×${seq}²×4=${(attentionPerExample / 2 ** 20).toFixed(0)} MB/example) ` +
      `exceeds WebGPU buffer cap ${(maxBuffer / 2 ** 30).toFixed(1)} GiB`,
    );
  }

  // Worker count — dGPU uses VRAM budget; iGPU caps at 1 (shared buffer contention).
  let maxWorkers = 1;
  if (caps.type === "dgpu" && caps.vramBytes) {
    const modelFootprint = fileBytes * 2;
    const activationFootprint = microbatch * seq * cfg.hiddenSize * 4 * cfg.numLayers * 2;
    const perWorker = modelFootprint + activationFootprint;
    maxWorkers = Math.max(1, Math.floor((caps.vramBytes * vramHeadroom) / perWorker));
  } else if (caps.type === "igpu" && caps.vramBytes) {
    // iGPU with explicit VRAM allocation (AMD UMA-framebuffer, Apple Unified Memory) —
    // allow 2 workers if budget permits; more risks thrashing the shared frame buffer.
    const modelFootprint = fileBytes * 2;
    const activationFootprint = microbatch * seq * cfg.hiddenSize * 4 * cfg.numLayers * 2;
    const perWorker = modelFootprint + activationFootprint;
    maxWorkers = Math.max(1, Math.min(2, Math.floor((caps.vramBytes * vramHeadroom) / perWorker)));
  }

  return {
    device: "webgpu",
    dtype,
    microbatch: Math.max(1, microbatch),
    maxWorkers,
    reason:
      `WebGPU chosen: model ${(fileBytes / 2 ** 20).toFixed(0)} MB, seq=${seq}, heads=${heads}, ` +
      `maxBuffer ${(maxBuffer / 2 ** 30).toFixed(1)} GiB → microbatch=${microbatch}, ` +
      `${caps.vendor ?? "GPU"} ${caps.type ?? ""} ${(caps.vramBytes ?? 0) ? `VRAM ${((caps.vramBytes ?? 0) / 2 ** 30).toFixed(1)} GiB` : ""} → workers=${maxWorkers}`,
  };
}

interface ModelConfig {
  hiddenSize: number;
  numHeads: number;
  numLayers: number;
  maxSeqLen: number;
}

const configCache = new Map<string, Promise<ModelConfig>>();
const fileSizeCache = new Map<string, Promise<number>>();

async function fetchModelConfig(modelId: string): Promise<ModelConfig> {
  if (!configCache.has(modelId)) {
    configCache.set(modelId, (async () => {
      const url = `https://huggingface.co/${modelId}/resolve/main/config.json`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        return {
          hiddenSize: Number(j.hidden_size ?? j.d_model ?? 768),
          numHeads: Number(j.num_attention_heads ?? j.num_heads ?? 12),
          numLayers: Number(j.num_hidden_layers ?? j.n_layers ?? j.num_layers ?? 12),
          maxSeqLen: Number(j.max_position_embeddings ?? j.model_max_length ?? 512),
        };
      } catch {
        // Safe fallback: assume a mid-size BERT.
        return { hiddenSize: 768, numHeads: 12, numLayers: 12, maxSeqLen: 512 };
      }
    })());
  }
  return configCache.get(modelId)!;
}

async function fetchModelOnnxSize(modelId: string, dtype: string): Promise<number> {
  const key = `${modelId}:${dtype}`;
  if (!fileSizeCache.has(key)) {
    fileSizeCache.set(key, (async () => {
      // transformers.js resolves `model_${dtype}.onnx` or `model.onnx` under `onnx/`.
      // Probe the most common names; return the first HEAD that succeeds.
      const base = `https://huggingface.co/${modelId}/resolve/main/onnx`;
      const candidates = [
        `${base}/model_${dtype}.onnx`,
        `${base}/model_${dtype === "q8" ? "quantized" : dtype}.onnx`,
        `${base}/model.onnx`,
        `https://huggingface.co/${modelId}/resolve/main/model.onnx`,
      ];
      for (const url of candidates) {
        try {
          const res = await fetch(url, { method: "HEAD" });
          const len = Number(res.headers.get("content-length") ?? 0);
          if (res.ok && len > 0) return len;
        } catch { /* try next */ }
      }
      return 0;
    })());
  }
  return fileSizeCache.get(key)!;
}

export function formatBudget(b: EmbedBudget): string {
  return `device=${b.device} dtype=${b.dtype} microbatch=${b.microbatch} workers=${b.maxWorkers} (${b.reason})`;
}
