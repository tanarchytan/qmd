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

Two integrations, both first-class options behind the existing `LOTL_EMBED_BACKEND` flag. Users pick based on infrastructure constraints. Same memory pipeline, same metrics — different storage of the embed model.

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
- First run downloads model from HuggingFace (~150-600MB depending on dtype) into `~/.cache/lotl/transformers/`.

**Integration effort:** ~120 lines. Same shape as `src/llm/fastembed.ts`. Wire in `src/memory/index.ts` as a fourth-priority embed path before fastembed.

**Activation:**

```sh
LOTL_EMBED_BACKEND=transformers
LOTL_TRANSFORMERS_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX  # default
LOTL_TRANSFORMERS_DTYPE=q8                                        # default
```

### Path B — `node-llama-cpp` GGUF (existing local layer)

QMD already has `node-llama-cpp` in `src/llm/local.ts` → `LlamaCpp`. It already supports loading any GGUF embedding model via env var. The infrastructure is in place — we just need to point it at the Qwen3 GGUF and re-enable `LOTL_LOCAL=yes` in the eval environment.

```sh
LOTL_LOCAL=yes
LOTL_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

**Pros:**
- **Zero new code.** The existing `LlamaCpp.embed()` method handles this exactly the way it handles `embeddinggemma-300M` today — `pullModels` downloads the GGUF, model loads into memory, `embed()` returns vectors.
- Native cmake-built ONNX runtime — much faster than `onnxruntime-web`. Closer to fastembed's `onnxruntime-node` performance.
- GPU acceleration if cmake builds with CUDA/Metal/Vulkan support.
- q8/q4 quantizations are compact (~150-300MB).
- **Best architectural fit** — already integrated with the LLM abstraction layer. Just another model URI.

**Cons:**
- Requires the cmake native build to succeed. The current WSL eval environment has `LOTL_LOCAL=no` because the build was never set up there.
- The OpenClaw plugin path explicitly disables local LLM (`--ignore-scripts` install) to avoid this dependency. Re-enabling `LOTL_LOCAL=yes` is per-environment, not global.
- node-llama-cpp's first GGUF load is slow (model loads into VRAM/RAM).

**Integration effort:** ~30 lines (env var override on the eval scripts) + cmake setup in WSL (~10 minutes if dependencies are already installed, longer if not).

**Activation:**

```sh
LOTL_LOCAL=yes
LOTL_EMBED_MODEL=hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
LOTL_EMBED_BACKEND=         # unset, falls through to LlamaCpp
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
2. Run LME _s n=500 with `LOTL_EMBED_BACKEND=transformers LOTL_TRANSFORMERS_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX`. Compare R@5 / multi-session R@5 against the partition-key MiniLM baseline (93.2% / 81%) and against BGE-base if it shipped.
3. Land Path B second by re-enabling `LOTL_LOCAL=yes` in WSL and running the same benchmark.
4. Verify both backends produce **bit-identical** vectors for the same input on the same model (sanity check — they should, since both use ONNX runtime under the hood).
5. Compare wall-clock per-question: Path A vs Path B should differ by ~10-30% (web vs native ORT).
6. Pick the default for new users (probably Path A for ergonomics, document Path B for performance).

## When to revisit

- **If the small-class A/B (gte-small / arctic-xs / mxbai-xsmall / e5-small / nomic) doesn't close the multi-session gap.** Try the same-size-class alternatives FIRST — they're cheap and stay within the on-device budget. Qwen3 is the heavier-weight option if the small class doesn't break 95% multi-session.
- **If we want any HuggingFace embed model on demand.** Path A unlocks the entire `onnx-community` org — mxbai-embed-large, jina-embeddings-v3, e5-mistral-7b, etc.
- **If a user requests Qwen3 explicitly.** Real demand signal trumps speculative perf wins.

## What the BGE A/B (2026-04-13) taught us

The BGE A/B was the gating test for "do we need Qwen3 at all". Result: **dimension is not the lever, training is.**

| Model | Dim | Size | n=100 R@5 | multi-session R@5 (n=30) | Wall (n=100) |
|---|---|---|---|---|---|
| MiniLM-L6-v2 | 384 | 80 MB | 98.0% | 93% | 4m47s |
| BGE-small-en-v1.5 | 384 | 130 MB | 97.0% | 93% | 7m25s |
| BGE-base-en-v1.5 | 768 | 440 MB | 98.0% | 93% | 29m02s |

All three score identically on multi-session. Doubling the embed dim (BGE-base) bought nothing and cost **6× wall time** vs MiniLM. **BGE-base is too big for QMD's on-device positioning regardless of whether it would have helped.**

Implications for Qwen3 (0.6B params, 1024-dim, ~600 MB fp32 / ~150 MB q8):

- **Path B (node-llama-cpp GGUF) is the only viable Qwen3 path** for QMD. The 0.6B model size is borderline but the GGUF q8 quantization (~150 MB) keeps it in the same disk-footprint class as BGE-small.
- **Path A (`@huggingface/transformers` ONNX q8)** — verify the ONNX q8 download is ≤200 MB and per-question time stays ≤10s. If onnxruntime-web's CPU performance falls off a cliff at 1024-dim, Path A may not be viable on developer laptops even though it works architecturally.
- **Run the small-class A/B (gte/arctic/mxbai/e5/nomic) BEFORE Qwen3.** If a 384-dim alternative closes the gap, we don't need to pay Qwen3's size+latency cost at all.

## What the small-class A/B (2026-04-13, same day) taught us

Followed the BGE A/B with a wider small-class field using the new
`@huggingface/transformers` (Path A) backend. Added `src/llm/transformers-embed.ts`
(~140 lines) during this session to enable arbitrary HF ONNX models — not
tied to fastembed's hardcoded enum.

**Toy-probe rankings (cosine spread on a 3-sentence probe) predicted nothing:**

| Model | Dim | Toy spread | LME _s n=100 |
|---|---|---|---|
| mxbai-embed-xsmall-v1 | 384 | 0.717 🏆 | **R@5 98.0% (tie)** |
| nomic-embed-text-v1.5 | 768 | 0.415 | ❌ OOM 48 GB batched matmul |
| embeddinggemma-300m | 768 | 0.30  | ❌ 14.6 GB RSS at load, cold-boot too slow |
| multilingual-e5-small | 384 | 0.197 | not run |
| jina-v5-nano-classif | 768 | 0.185 | ❌ OOM at ingest start |
| MiniLM baseline (fastembed) | 384 | — | R@5 98.0% (canonical) |
| MiniLM (same model, tjs path) | 384 | — | R@5 98.0% (apples-to-apples check) |

**Findings:**

1. **Retrieval ceiling is MiniLM.** mxbai-xsmall ties R@5/R@10/MRR **exactly** on n=100 (98/98/0.932). Multi-session R@5 stays 93%. No 384d alternative tested beats MiniLM on this workload.
2. **transformers.js CPU ORT is fragile for 768d+ encoders** at QMD's batch shapes. Nomic OOM'd at 22 GB (48 GB allocation request), jina nano died at ingest start, gemma-300m reached 14.6 GB RSS before cold-boot made it infeasible. WSL itself crashed twice with `E_UNEXPECTED`. Fastembed's native `onnxruntime-node` handles batches more robustly than transformers.js's `onnxruntime-web`.
3. **Apples-to-apples proves equivalence at 384d.** Running MiniLM via fastembed (5m01s) and via transformers.js (5m01s) returns identical R@5/R@10/MRR — no runtime penalty for switching backends for small encoders.
4. **Decoder-arch models don't fit transformers.js `feature-extraction`.** Harrier (Gemma3TextModel) fails with `undefined.data` — no encoder pooling head. Had to drop.
5. **Toy-probe cosine spread ≠ retrieval quality.** mxbai's extreme 0.717 spread did not translate to any LME advantage over MiniLM's unmeasured-but-smaller spread.

**Implications for Qwen3 (now even dimmer):**

- If 768d models cannot survive transformers.js CPU at QMD's batch shapes, **1024d Qwen3 via Path A is almost certainly dead on arrival.** Path B (GGUF via node-llama-cpp) becomes the only realistic route.
- But **GGUF path is slow** — harrier-270m GGUF n=100 took **25m06s** vs fastembed MiniLM 5m01s (5× slower). Qwen3 0.6B would be ~40+ minutes at n=100, ~3+ hours at n=500.
- **If embed is not the lever, Qwen3 doesn't matter.** Multi-session R@5 stuck at 93% across MiniLM / harrier / mxbai / BGE-small / BGE-base. Six different embed models, same score. Confirmed: **this is a ranking problem, not a coverage problem.**

**Next experiments should target rerank, not embed:**

- Cross-encoder rerank: `mixedbread-ai/mxbai-rerank-base-v1` (ONNX) via new `TransformersRerankBackend`
- Query expansion: tune prompt structure, test multi-query
- BM25/vector fusion weight sweep
- Per-scope normalization (avoid cross-scope score drift)

The embed A/B is effectively closed for now. Path A backend is kept in tree — it unlocks future HF ONNX models as needed (and will be reused for the cross-encoder rerank work).

## Round 2 (same day, 2026-04-13) — quantized variants beat the baseline

After the small-class A/B closed with no clear winner over MiniLM, ran a quantization sweep on MiniLM-L6 + mxbai-xsmall using non-standard ONNX filenames (`model_quint8_avx2`, `model_qint8_avx512_vnni`, `model_int8`). Required adding a `model_file_name` override hook to `transformers-embed.ts` since transformers.js dtype resolution maps to fixed names and these repos use bespoke filenames.

**LME _s n=500 results:**

| Model | Dim | Size | R@5 | R@10 | MRR | multi-session R@5 | knowledge-update | Time | vs baseline |
|---|---|---|---|---|---|---|---|---|---|
| MiniLM-L6 fp32 (fastembed baseline) | 384 | 90 MB | 93.2% | **95.2%** | **0.862** | 81% | 97% | 23m33s | — |
| **MiniLM-L6 uint8** (transformers.js, `model_quint8_avx2`) | 384 | 23 MB | **94.4%** | 94.8% | 0.859 | **83%** | 97% | 17m09s | +1.2 R@5, +2 multi, −27% time |
| **mxbai-xs q8** (transformers.js, `model_quantized`) | 384 | 24 MB | 94.2% | 94.4% | 0.857 | 82% | **99%** | **14m49s** | +1.0 R@5, +1 multi, **−37% time** |

**This is the first real movement on multi-session R@5 in many sessions.** Six embed models at fp32 (MiniLM, BGE-small, BGE-base, harrier-270m GGUF, mxbai-xs fp32, MiniLM-L6 fp32 via transformers.js) all stuck at 81%. Quantizing to int8/uint8 lifted it to 82-83% — a 1-2pp swing on the stubborn metric. Likely explanation: quant noise breaks ties between near-duplicate vectors that fp32 was packing into the same bucket. The noise acts as a soft ranking diversifier.

**The R@10 inversion is real:** baseline wins R@10 (95.2% vs 94.8% / 94.4%). Quantized loses some top-6-to-10 stability while gaining top-5 ceiling. For QMD's recall-into-prompt use case, R@5 matters more than R@10 — top-5 results land in the prompt, ranks 6-10 rarely do.

**Production decision (2026-04-13):** mxbai-xs q8 promoted to default.

- 37% wall reduction at n=500 — biggest speed delta in the sweep
- +1.0pp R@5 over fp32 baseline, +1pp multi-session
- 24 MB on disk vs 90 MB
- Same 384d footprint as MiniLM (drop-in vector-table compatibility)
- Different architecture — accepts that we're trading MemPalace lineage for production speed
- Auto-fallback wired in `src/memory/index.ts`: if transformers backend fails to load on the host, drops to fastembed MiniLM AllMiniLML6V2 (the prior baseline) so recall keeps working with no config change

**Ceiling-trigger fallback path:** if mxbai-xs q8 hits a ceiling on a future workload (e.g. domain-specific drift, multilingual content), revert to MiniLM-L6 uint8 — it has the strongest multi-session R@5 of all the quantized variants tested and shares the MemPalace lineage. Both are first-class supported configs.

**What this changed in code:**
- `src/llm/transformers-embed.ts` default modelId switched from `harrier-oss-v1-270m-ONNX` to `mixedbread-ai/mxbai-embed-xsmall-v1`, default dtype stays `q8`
- `src/memory/index.ts` `getFastEmbedBackend()` gained an auto-fallback path: transformers fail → fastembed MiniLM
- `evaluate/run-embed-ab-onnx.sh` extended with quantized variant runs behind `RUN_*` flags
- `evaluate/sanity-transformers2.mjs` added — quant sweep harness reusable for future model evaluations

## Doctrine reminder

> Where MemPalace makes doubtful choices, prioritize project quality over shiny benchmarks.

This applies here too. Adding Qwen3 because it scores higher on a benchmark is fine **if** it also makes production memory better for real users. A 600MB embed model is heavier than a 80MB one — for users with small vaults the difference doesn't pay off. Default stays MiniLM; Qwen3 is opt-in for users whose multi-hop retrieval matters and whose disk budget allows it.
