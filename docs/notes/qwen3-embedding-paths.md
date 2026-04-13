# Qwen3-Embedding-0.6B — two parallel integration paths

> **Status:** planned. Not on a version roadmap yet. Wait for the BGE A/B
> result first — if BGE-base closes the LME _s multi-session gap on its own,
> Qwen3 is unnecessary. If it doesn't, both paths below are ready to
> implement.

## Why Qwen3-Embedding-0.6B specifically

The LME _s n=500 partition-key fix landed multi-session R@5 at 81% (vs MemPalace's 100%). With full top-K per scope already retrieved, this is now a **ranking** problem, not a coverage problem. MiniLM (384-dim) embeddings don't put the right multi-hop answer in the top-5 for 19% of multi-session questions. The targeted fix is a stronger embed model.

Qwen3-Embedding-0.6B is one of the strongest small embedders publicly available:

- 1024-dim embeddings (vs MiniLM's 384)
- ~600MB fp32, ~150MB q8
- Trained on multilingual + multi-task data
- Top of MTEB sub-1B leaderboard at release
- HuggingFace identifier: `Qwen/Qwen3-Embedding-0.6B` (HF) / `onnx-community/Qwen3-Embedding-0.6B-ONNX` (ONNX) / `Qwen/Qwen3-Embedding-0.6B-GGUF` (GGUF)

BGE-base-en-v1.5 (the next BGE A/B candidate) is 768-dim and typically lands ~2-5pp behind Qwen3 on multi-hop benchmarks. So even if BGE wins over MiniLM, Qwen3 may push further.

## Hybrid plan: ship both paths

Two integrations, both first-class options behind the existing `QMD_EMBED_BACKEND` flag. Users pick based on infrastructure constraints. Same memory pipeline, same metrics — different storage of the embed model.

### Path A — `@huggingface/transformers` backend (pure Node)

The rebranded `@xenova/transformers`. Native Qwen3 support via the standard pipeline API.

```ts
// src/llm/transformers-embed.ts
import { pipeline } from "@huggingface/transformers";

export class TransformersEmbedBackend {
  private extractor: any;

  static async create(modelId: string = "onnx-community/Qwen3-Embedding-0.6B-ONNX") {
    const extractor = await pipeline("feature-extraction", modelId, {
      dtype: "q8",  // or "fp32" / "fp16"
      cache_dir: defaultCacheDir(),
    });
    return new TransformersEmbedBackend(extractor);
  }

  async embed(text: string) {
    const out = await this.extractor(text, { pooling: "mean", normalize: true });
    return { embedding: Array.from(out.data), model: "qwen3-embedding-0.6b" };
  }

  async embedBatch(texts: string[]) {
    const out = await this.extractor(texts, { pooling: "mean", normalize: true });
    // out.tolist() returns number[][] of [batch, dim]
    return out.tolist().map((vec: number[]) => ({ embedding: vec, model: "qwen3-embedding-0.6b" }));
  }
}
```

**Pros:**
- Pure Node + onnxruntime-web. No cmake. No native build dance.
- Single npm install. Works in WSL the same way fastembed does.
- Native Qwen3 support — no manual file management.
- `dtype` flag picks the precision (q8 ≈ 150MB, fp16 ≈ 300MB, fp32 ≈ 600MB).
- Same project supports BGE, e5, mxbai, jina, etc. — adding any future model is one config change.

**Cons:**
- ~46MB package + transitive `sharp` (~30MB, used for image preprocessing in vision pipelines but pulled in for feature-extraction too).
- Uses `onnxruntime-web`, ~10-30% slower on CPU than fastembed's `onnxruntime-node` native bindings.
- First run downloads model from HuggingFace (~150-600MB depending on dtype) into `~/.cache/qmd/transformers/`.

**Integration effort:** ~120 lines. Same shape as `src/llm/fastembed.ts`. Wire in `src/memory/index.ts` as a fourth-priority embed path before fastembed.

**Activation:**

```sh
QMD_EMBED_BACKEND=transformers
QMD_TRANSFORMERS_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX  # default
QMD_TRANSFORMERS_DTYPE=q8                                        # default
```

### Path B — `node-llama-cpp` GGUF (existing local layer)

QMD already has `node-llama-cpp` in `src/llm/local.ts` → `LlamaCpp`. It already supports loading any GGUF embedding model via env var. The infrastructure is in place — we just need to point it at the Qwen3 GGUF and re-enable `QMD_LOCAL=yes` in the eval environment.

```sh
QMD_LOCAL=yes
QMD_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

**Pros:**
- **Zero new code.** The existing `LlamaCpp.embed()` method handles this exactly the way it handles `embeddinggemma-300M` today — `pullModels` downloads the GGUF, model loads into memory, `embed()` returns vectors.
- Native cmake-built ONNX runtime — much faster than `onnxruntime-web`. Closer to fastembed's `onnxruntime-node` performance.
- GPU acceleration if cmake builds with CUDA/Metal/Vulkan support.
- q8/q4 quantizations are compact (~150-300MB).
- **Best architectural fit** — already integrated with the LLM abstraction layer. Just another model URI.

**Cons:**
- Requires the cmake native build to succeed. The current WSL eval environment has `QMD_LOCAL=no` because the build was never set up there.
- The OpenClaw plugin path explicitly disables local LLM (`--ignore-scripts` install) to avoid this dependency. Re-enabling `QMD_LOCAL=yes` is per-environment, not global.
- node-llama-cpp's first GGUF load is slow (model loads into VRAM/RAM).

**Integration effort:** ~30 lines (env var override on the eval scripts) + cmake setup in WSL (~10 minutes if dependencies are already installed, longer if not).

**Activation:**

```sh
QMD_LOCAL=yes
QMD_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
QMD_EMBED_BACKEND=         # unset, falls through to LlamaCpp
```

## Why both, not one

| Constraint | Best path |
|---|---|
| WSL / Linux / Mac with cmake working | Path B (faster, native) |
| Windows native or restricted env (no cmake) | Path A (pure Node, works anywhere) |
| OpenClaw plugin path (`--ignore-scripts`) | Path A (Path B requires the native build) |
| Need GPU acceleration | Path B (Metal/CUDA via cmake flags) |
| Want one model file shared across local LLM + embed | Path B (GGUF is universal) |
| Want zero environment setup | Path A (npm install + run) |

Each user's "right" path depends on their infrastructure. Shipping both means we don't force a choice on them.

## Test plan when we implement

1. Land Path A first (lower risk — no native build).
2. Run LME _s n=500 with `QMD_EMBED_BACKEND=transformers QMD_TRANSFORMERS_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX`. Compare R@5 / multi-session R@5 against the partition-key MiniLM baseline (93.2% / 81%) and against BGE-base if it shipped.
3. Land Path B second by re-enabling `QMD_LOCAL=yes` in WSL and running the same benchmark.
4. Verify both backends produce **bit-identical** vectors for the same input on the same model (sanity check — they should, since both use ONNX runtime under the hood).
5. Compare wall-clock per-question: Path A vs Path B should differ by ~10-30% (web vs native ORT).
6. Pick the default for new users (probably Path A for ergonomics, document Path B for performance).

## When to revisit

- **If BGE A/B doesn't close the multi-session gap** (today / next session). BGE-base is the cheapest experiment — try it first, before adding new dependencies.
- **If we want any HuggingFace embed model on demand.** Path A unlocks the entire `onnx-community` org — mxbai-embed-large, jina-embeddings-v3, e5-mistral-7b, etc.
- **If a user requests Qwen3 explicitly.** Real demand signal trumps speculative perf wins.

## Doctrine reminder

> Where MemPalace makes doubtful choices, prioritize project quality over shiny benchmarks.

This applies here too. Adding Qwen3 because it scores higher on a benchmark is fine **if** it also makes production memory better for real users. A 600MB embed model is heavier than a 80MB one — for users with small vaults the difference doesn't pay off. Default stays MiniLM; Qwen3 is opt-in for users whose multi-hop retrieval matters and whose disk budget allows it.
