# Embedder candidates — Phase 11 planning

Rule: **int8 ONNX required**, **≤1024 dim** (or Matryoshka-truncatable to ≤1024).

## Already tested on LME

Benchmarks against LongMemEval _s. Scores are the period's best; the 2026-04-13 numbers used the old additive pipeline (before RRF restructure).

### Succeeded (benchmarked)

| Model | Dim | Size (q8) | ONNX int8 | LME R@5 | LME MRR | multi-R@5 | Wall | Verdict |
|---|---|---|---|---|---|---|---|---|
| **mixedbread-ai/mxbai-embed-xsmall-v1** | 384 | ~50 MB | ✅ native | 94.2% (old), 98.4% (new) | 0.857 → 0.917 | 82% | 14m49s | **Production default** |
| sentence-transformers/all-MiniLM-L6-v2 (file=`model_quint8_avx2`) | 384 | ~23 MB | ✅ canonical | 94.4% | 0.859 | 83% | 17m09s | Viable fallback |
| sentence-transformers/all-MiniLM-L6-v2 (fp32 via fastembed, not q8) | 384 | ~90 MB | n/a | 93.2% | 0.862 | 81% | 23m33s | Too slow (fp32) |
| Snowflake/snowflake-arctic-embed-s q8 | 384 | ~35 MB | ✅ | 93.2% | — | 84.2% | — | **Strictly worse than mxbai-xs on every sr5 bucket.** Pref -10pp. Parked 2026-04-14 post metric-audit. |
| intfloat/multilingual-e5-small | 384 | — | ✅ | n/a (toy probe only) | — | — | — | Weak spread on probe, not LME-tested |

### all-MiniLM-L6-v2 ONNX variant catalog (canonical repo)

Previously we only tested `model_quint8_avx2`. The official repo ships 9 variants:

| File | Size | Type | When to use |
|---|---|---|---|
| `model.onnx` | 90.4 MB | fp32 | Ground truth, no speedup |
| `model_O1.onnx` | 90.4 MB | fp32 + O1 opt | Mild graph optimization |
| `model_O2.onnx` | 90.3 MB | fp32 + O2 opt | More aggressive |
| `model_O3.onnx` | 90.3 MB | fp32 + O3 opt | Extended graph opt |
| `model_O4.onnx` | 45.2 MB | fp16 + O4 opt | Half-precision + aggressive |
| `model_qint8_arm64.onnx` | 23 MB | int8, ARM | Apple Silicon, ARM servers |
| `model_qint8_avx512.onnx` | 23 MB | int8, AVX-512 | Server Xeons |
| `model_qint8_avx512_vnni.onnx` | 23 MB | int8, AVX-512 VNNI | Modern Intel (Ice Lake+, Alder Lake+) |
| `model_quint8_avx2.onnx` | 23 MB | int8 (unsigned), AVX2 | **Older x64 / safe default (we tested this one)** |

**Implication for Phase 11 retesting:**
On modern Intel CPUs, `model_qint8_avx512_vnni` may give a free throughput bump over `model_quint8_avx2` without any quality change. Worth testing as part of the same A/B matrix.

Pattern applies to **all retrieval models that ship canonical ONNX variants** — we should check each Phase 11 candidate's `/onnx/` folder and pick the best arch match for the target CPU.

**Key finding (2026-04-13):** int8/uint8 quantization broke the 81% multi-session ceiling that 6 fp32 models all hit. Quantization noise is a soft ranking diversifier.

### Failed on WSL (re-testable on Windows native or via onnx-community port)

| Model | Dim | Failure mode | Retry on Windows? |
|---|---|---|---|
| google/embeddinggemma-300m | 768 | 14.6 GB RSS at load (was fp32) | **YES** — `onnx-community/embeddinggemma-300m-ONNX` int8 (309 MB). In candidates list. |
| nomic-ai/nomic-embed-text-v1.5 | 768 | 48 GB alloc OOM (8K context expansion) | Try with smaller context cap. In candidates list. |
| jinaai/jina-v5-text-nano (old `-nano-classification` variant) | 384 | OOM at ingest | Superseded — use `jina-embeddings-v5-text-nano-retrieval` int8. In candidates list. |
| F2LLM-v2 GGUF (80M / 160M / 330M) | — | Tokenizer missing from node-llama-cpp prebuilt | **NO** — GGUF path removed from qmd |
| harrier-oss-v1-270m | — | Decoder model, not encoder. transformers.js `feature-extraction` returns undefined | **NO** — architecturally wrong |

### Excluded categories (won't retest)

| Category | Example models | Reason |
|---|---|---|
| Multilingual | `distiluse-base-multilingual-*`, `paraphrase-multilingual-*`, `LaBSE` | English-only corpus; multilingual trades English strength for breadth |
| Multimodal | `clip-ViT-B-32`, `clip-ViT-B-16`, `clip-ViT-L-14` | Text-only memory — image alignment is overhead |
| Scientific / domain-specific | `allenai-specter`, SciBERT | Trained on paper/citation pairs; breaks on conversational text |
| >1024 dim | `bge-m3` (8192d), large multilingual variants | Violates 1024d cap (sqlite-vec scaling + storage) |
| GGUF-only | Original nomic, F2LLM, various | qmd removed node-llama-cpp / GGUF path in 2026-04-13 cleanup |
| Decoder models | Gemma / Llama derivatives without encoder head | transformers.js `feature-extraction` pipeline incompatible |
| >500 MB int8 download | Many 1B+ param models | Breaks zero-setup install story, doesn't fit CPU inference budget

## Device auto-select (2026-04-17 evening)

Added as part of Phase 11.5. Any candidate listed here can now be run with
`LOTL_TRANSFORMERS_DEVICE=auto` and the sizer picks device/microbatch/workers
from model config + hardware probe. See `src/llm/gpu-probe.ts` and
`src/llm/embed-sizer.ts`.

**Current limitation:** in Node, transformers.js v4.1.0 does not expose
`navigator.gpu` to external code, so the sizer uses OS-level signals (WMI
on Windows, sysfs on Linux, system_profiler on macOS) as primary GPU
detection and defaults `maxBufferSize` to the WebGPU spec floor of 2 GiB.
This is correct for all iGPUs we've measured.

**Auto-sizer output for the Phase 11 candidate set on AMD Radeon 780M
(4 GiB UMA, 2 GiB maxBuffer):**

| Model | Device | Microbatch | Workers |
|---|---|---|---|
| mxbai-embed-xsmall-v1 (seq 4096) | webgpu | 1 | 2 |
| embgemma-300m (seq 2048, 3 heads) | webgpu | 29 | 1 |
| mxbai-embed-large-v1 (seq 512, 16 heads) | webgpu | 89 | 1 |
| bge-base-en-v1.5 (seq 512, 12 heads) | webgpu | 119 | 1 |

The sizer correctly picks microbatch based on `heads × seq² × 4 / (maxBuffer × 0.70)`.
embgemma still fails in practice due to per-shape shader JIT (see attempt log above),
not buffer math.

## AMD NPU path — CANCELED for v1.0

Originally explored (AMD XDNA NPU on Ryzen 7 PRO 7840U, 10 TOPS). VitisAI EP
is Python-only with no Node.js binding; needs `vai_q_onnx` quantization pass;
most embedders compile partially with silent CPU fallback. The Node + WebGPU
path already covered our latency budget, so the NPU work was dropped in
Lotl v1.0 — detection code removed from `src/llm/gpu-probe.ts`, TODO Phase 11.6
marked CANCELED. Re-open only if a first-class Node NPU runtime appears.

## Phase 11 results (2026-04-17 sweep — concluded)

**Outcome: mxbai-xs q8 remains permanent production default.** No candidate tested produced a clear win; the ones that matched baseline cost significantly more latency for no gain.

### n=100 sanity results

| Model | Dim | Size | rAny@5 | R@5 | MRR | NDCG@10 | covR5 | covMRR | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **mxbai-xs q8 (baseline, n=500)** | **384** | **~50 MB** | **98.4%** | **93.7%** | **0.917** | **0.913** | **93.6%** | **0.857** | **Production default** |
| Xenova/gte-small int8 | 384 | 33 MB | 99.0% | 93.9% | **0.921** | **0.925** | 98.0% | 0.919 | n=100 promised +0.4pp MRR; n=500 follow-up 2026-04-23 (`results-gte-small-500.json`) returned rAny@5=97.8% / R@5=93.3% / MRR=0.912 — **below baseline on both gates**. Parked. mxbai-xs stays default. |
| Xenova/e5-small-v2 int8 | 384 | 33 MB | 98.0% | 92.9% | 0.909 | 0.912 | 98.0% | 0.920 | Below baseline MRR. Parked. |
| BAAI/bge-small-en-v1.5 int8 (Xenova port) | 384 | ~33 MB | 99.0% | 93.4% | 0.916 | 0.918 | 98.0% | 0.919 | Tied. Parked. |
| Alibaba-NLP/gte-base-en-v1.5 int8 | 768 | 140 MB | — | — | — | — | — | — | transformers.js v4.1.0 arch incompat: `model_type="new"` not registered. Silent crash. Parked. |
| Xenova/e5-base-v2 int8 | 768 | ~110 MB | 99.0% | 93.9% | 0.913 | 0.913 | 98.0% | 0.923 | Tied. Parked (3x params, no MRR lift). |
| BAAI/bge-base-en-v1.5 int8 (Xenova port) | 768 | ~104 MB | 99.0% | 93.9% | 0.914 | 0.913 | 98.0% | 0.920 | Tied. Parked. |
| nomic-ai/nomic-embed-text-v1.5 int8 | 768 | 140 MB | — | — | — | — | — | — | transformers.js v4.1.0 arch incompat: custom BERT variant not registered. Silent crash. Parked. |
| mixedbread-ai/mxbai-embed-large-v1 | 1024 | ~335 MB | — | — | — | — | — | — | Killed at 32/100 (too slow for sanity gate). Parked. |
| **Xenova/bge-large-en-v1.5 int8** | 1024 | ~340 MB | **99.0%** | **93.88%** | **0.9267** | **0.9291** | 98.0% | 0.9253 | **Tied ceiling pick.** +1.0pp MRR, +1.6pp NDCG@10 vs baseline. 10× params, ~40 min/n=100 on CPU. Deploy only with GPU. |
| **Xenova/UAE-Large-V1 int8** | 1024 | ~340 MB | **99.0%** | **93.88%** | **0.9267** | **0.9295** | 98.0% | 0.9250 | **Tied with bge-large** to 4 decimal places. Indistinguishable at n=100. Same ship recommendation. |
| Xenova/e5-large-v2 int8 | 1024 | ~340 MB | 99.0% | 93.88% | 0.9093 | 0.9155 | 98.0% | 0.9140 | Below baseline. Likely needs `passage:` prefix at ingest (not done) — current run had `query:` at embed-query but raw at embed-store, which mismatches E5 training. Parked without a re-ingest. |
| onnx-community/embeddinggemma-300m-ONNX | 768 | ~309 MB | — | — | — | — | — | — | OOM at 6.12 GB (external-data expansion in transformers.js). Parked. |
| jinaai/jina-embeddings-v5-text-nano-retrieval | 768 | ~247 MB | — | — | — | — | — | — | `feature-extraction` pipeline returns undefined (custom Qwen3-LoRA architecture incompatible with transformers.js generic pipeline, including v4.1.0). Parked. |

**Phase 11.7 final leaderboard (n=100, 2026-04-17):**

| Rank | Model | MRR | Params | Practical note |
|---|---|---|---|---|
| 🥇 | bge-large-en-v1.5 | **0.9267** | 335M | Ceiling; CPU-too-slow without GPU |
| 🥇 | UAE-Large-V1 | **0.9267** | 335M | Tied with bge-large, indistinguishable |
| ❌ | gte-small | 0.9212 (n=100) → 0.912 (n=500) | 30M | n=100 lift didn't replicate at n=500 — both rAny@5 (97.8% vs 98.4% gate) and MRR (0.912 vs 0.917 gate) regressed. Parked 2026-04-23. |
| — | mxbai-xs q8 (baseline) | 0.917 | 22M | Current production default |
| — | bge-small / bge-base / e5-base | ~0.913-0.916 | 33-109M | Tied with baseline. Parked. |
| — | e5-small / e5-large | ~0.909 | 33-335M | Below baseline (prefix-at-ingest mismatch — needs re-ingest to be fair) |

**Update 2026-04-23:** n=500 follow-up did NOT confirm gte-small's +0.4pp MRR. mxbai-xs stays as production default. The n=100 sweep size was too small to discriminate between near-tied embedders at this MRR ceiling — future Phase 11 candidates should gate at n=500 directly, not promote from n=100.

**bge-large / UAE-Large** are ceiling options only viable after we ship dedicated GPU inference (Phase 11.5 WebGPU path). n=500 sweep (Phase 11.8) confirmed they tie mxbai-xs on MRR but regress on preference MRR — not worth the 15× param cost regardless of device.

**Transformers.js v4.1.0 arch-incompat list** (all silent-crash on load — handled with explicit skip in `run-cpu-sweep.sh`):
- `Alibaba-NLP/gte-base-en-v1.5` (`model_type="new"`)
- `nomic-ai/nomic-embed-text-v1.5` (custom BERT)
- `jinaai/jina-embeddings-v5-text-nano-retrieval` (`JinaEmbeddingsV5`)

Root cause is the same for all three: transformers.js `feature-extraction` pipeline dispatches by registered `model_type`. New architectures need upstream PRs. Track the registry at `node_modules/@huggingface/transformers/dist/transformers.node.mjs`.

### embgemma-300m on WebGPU — attempted 2026-04-17 evening after transformers.js v4.1.0 upgrade

WebGPU loads the model without OOM (avoids the CPU int8→fp32 external-data expansion that caused 6.12 GB RSS). **Still not viable:**

| Attempt | microbatch | Outcome |
|---|---|---|
| n=100 LME, workers=2 | 64 | **WebGPU buffer overrun** (2.26 GB > 2 GiB per-buffer cap) on first batched encode. transformers.js caught it and fell back to per-item which was never going to finish. |
| n=100 LME, workers=1 | 4 | Stable, but **7 min on question 1** due to per-shape shader JIT. ETA 2+ hours. Killed. |
| n=100 LME, CPU, workers=1 | 1 | Stable at 2 GB RSS (no OOM!), **~2.5 s/embed** → 3.5 h ETA. Killed. |

**Root cause:** embgemma uses seq=2048 with small attention heads (3); every unique input length triggers a fresh WebGPU shader compile. LME memories vary wildly in length, so shader cache never warms.

**Verdict:** embgemma-300m **permanently parked** unless:
1. A smaller Matryoshka variant surfaces (truncated to 256d or 384d with seq ≤ 512), or
2. We add an `onnxruntime-node` + DirectML EP backend that avoids the WebGPU shader-JIT path entirely.

### Interpretation

- At n=100, preference coverage numbers (covR5, covMRR) look high because the preference subset is only ~20 questions. Not comparable to n=500 baseline's 93.6% / 0.857.
- bge-small and bge-base are essentially tied with mxbai-xs on rAny@5 and MRR, but each costs 2-5x more parameters and noticeably more wall time.
- No candidate cleared the user's "cut off from baseline mxbai" threshold with enough headroom to justify a full n=500 validation.
- **Phase 11 closed. Revisit if:** a retrieval-trained model ships with int8 ONNX + documented MTEB retrieval ≥65 AND the params/latency budget makes sense, OR the current pipeline is no longer BM25-dominant (a stronger embedder would help only if vec weight shifts meaningfully).

### Next time a candidate looks promising

Follow the same methodology:

1. Verify int8 ONNX exists on the canonical repo OR a trusted port (Xenova, onnx-community).
2. Direct load test first (`LOTL_TRANSFORMERS_EMBED=<model>` + small probe) to catch architecture incompat early.
3. Watch for external-data expansion OOMs — `.onnx` files that require a sidecar `.onnx_data` blob can balloon at load.
4. n=100 sanity. If rAny@5 or MRR are >1pp below baseline, park.
5. If n=100 holds, n=500 for full validation before declaring a winner.

## Phase 11 candidates (int8 ONNX, ≤1024d, retrieval-trained)

Checked each model card for ONNX + int8 availability.

### Same family as current (safe upgrades)

| Model | Dim | MTEB retrieval | ONNX int8 | Notes |
|---|---|---|---|---|
| **mixedbread-ai/mxbai-embed-large-v1** | 1024 | 60.4 | ✅ native | Same family as xsmall. 512-token context. Safe upgrade path. |

### BGE family (strong retrieval scores)

| Model | Dim | MTEB retrieval | ONNX int8 | Notes |
|---|---|---|---|---|
| BAAI/bge-small-en-v1.5 | 384 | 62.2 | ✅ native + Xenova | Same dim as current. Drop-in comparable. |
| BAAI/bge-base-en-v1.5 | 768 | 63.5 | ✅ native + Xenova | Mid-size, strong MTEB. |
| BAAI/bge-large-en-v1.5 | 1024 | 63.98 | ✅ native | At dim cap. |

### Sentence-Transformers originals (sbert.net recommendations)

| Model | Dim | MTEB retrieval | ONNX int8 | Notes |
|---|---|---|---|---|
| Xenova/all-mpnet-base-v2 | 768 | 43.81 | ✅ Xenova port | sbert "best quality" general. Weaker on retrieval-specific benchmarks. |
| Xenova/multi-qa-mpnet-base-cos-v1 | 768 | (57.46 sbert semantic search) | ✅ Xenova port | QA-pair trained. Cosine-normalized. Fits our cosine pipeline. |
| Xenova/multi-qa-distilbert-cos-v1 | 768 | (52.83 sbert) | ✅ Xenova port | Lighter alternative. |
| Xenova/multi-qa-MiniLM-L6-cos-v1 | 384 | (51.83 sbert) | ✅ Xenova port | Tiny, fast. Drop-in comparable to current. |
| Xenova/msmarco-MiniLM-L6-cos-v5 | 384 | (42.16 sbert semantic search) | ✅ Xenova port | MSMARCO-trained, smaller. |

### Frontier retrieval models (2024-2025)

| Model | Dim | MTEB retrieval | ONNX int8 | Notes |
|---|---|---|---|---|
| **onnx-community/embeddinggemma-300m-ONNX** | 768 (→512/256/128) | **#1 <500M on MTEB** | ✅ `model_quantized.onnx` (309 MB) | Google Gemma-3-based. Matryoshka-truncatable. Previous WSL OOM was fp32 (1.23 GB tensor); int8 variant should fit Windows 16 GB. |
| **jinaai/jina-embeddings-v5-text-nano-retrieval** | 768 (→32-768) | MTEB English 71.0 (overall) | ✅ `model_quantized.onnx` (247 MB) | **Released Feb 2026.** Retrieval LoRA pre-merged — no prefix injection needed in qmd pipeline. 239M params. Multilingual (15+ langs) overhead for English-only corpus. Outperforms v3 at similar size per Jina. |
| jinaai/jina-embeddings-v5-text-small-retrieval | 1024 (→32-1024) | 63.28 (5-benchmark avg) | ❌ fp32 only (2.38 GB) | Need int8 port before usable. 677M params. |
| jinaai/jina-embeddings-v3 | 1024 | 66.65 | ✅ native | Superseded by v5. LoRA adapters require task prefix. |
| nomic-ai/nomic-embed-text-v1.5 | 768 | 62.39 | ✅ native | Matryoshka — truncatable to 384/512. Previously OOM'd on WSL (8K context). |
| intfloat/e5-small-v2 | 384 | 57.52 | ✅ Xenova port | Needs query/passage prefix at embed time. |
| intfloat/e5-base-v2 | 768 | 59.63 | ✅ Xenova port | Same prefix requirement. |
| intfloat/e5-large-v2 | 1024 | 62.25 | ✅ Xenova port | At dim cap. |
| WhereIsAI/UAE-Large-V1 | 1024 | 64.64 | ✅ available | Strong retrieval, at dim cap. |
| Qwen/Qwen3-Embedding-0.6B | 1024 | ~63+ | ✅ native (plus GGUF) | Multilingual (skip if English-only bias OK). Large model. |

### Intentionally excluded

| Category | Reason |
|---|---|
| Multilingual (paraphrase-multilingual-*, LaBSE, distiluse) | English-only corpus — multilingual models trade English strength |
| Multimodal (CLIP variants) | Text-only memory |
| Scientific (allenai-specter) | Wrong domain (paper citations) |
| >1024 dim (bge-m3 8192d, etc.) | Violates user's dim cap |
| GGUF-only (F2LLM, pre-2024 nomic) | qmd removed node-llama-cpp in 2026-04-13 cleanup |

## Recommended test order (Phase 11)

Cheapest → highest-upside. Stop on first clear win.

1. **BAAI/bge-small-en-v1.5** (384d, same dim as current) — lowest risk, direct comparison
2. **mixedbread-ai/mxbai-embed-large-v1** (1024d, same family) — native upgrade path
3. **onnx-community/embeddinggemma-300m-ONNX** (768d, Matryoshka) — #1 MTEB <500M, int8 is 309 MB
4. **jinaai/jina-embeddings-v5-text-nano-retrieval** (768d, Matryoshka) — freshest 2026 release, MTEB 71.0, int8 247 MB, retrieval LoRA pre-merged
5. **BAAI/bge-base-en-v1.5** (768d) — strong MTEB baseline at middle dim
6. **nomic-ai/nomic-embed-text-v1.5** (768d) — Matryoshka dim reduction option

## Test procedure (no code change)

```sh
# Set env var, run n=100 sanity (~3 min)
LOTL_TRANSFORMERS_EMBED=<candidate> LOTL_TRANSFORMERS_DTYPE=q8 \
LOTL_EMBED_BACKEND=transformers LOTL_VEC_MIN_SIM=0.1 \
LOTL_RECALL_RAW=on LOTL_INGEST_EXTRACTION=off LOTL_INGEST_REFLECTIONS=off \
LOTL_INGEST_SYNTHESIS=off LOTL_INGEST_PER_TURN=off LOTL_EMBED_MICROBATCH=64 \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 100 --no-llm \
  --workers 2 --tag embed-<short-name> --db-suffix embed-<short-name>
```

If n=100 holds: n=500 full (~15-20 min).

## Gates at n=500

- recall_any@5 ≥ 98.4% (current baseline — must hold or beat)
- preference rAny5 ≥ 97%
- preference MRR > 0.745 (target >0.80)
- multi-session R@5 ≥ 90%
- Wall ≤ 20 min (budget for larger dims)

If wins: **re-sweep RRF weights** (expect shift from 0.9/0.1 BM25-heavy toward 0.5/0.5 or vec-heavy if the new embedder actually carries signal).

## Sources

- [sbert.net pretrained_models](https://sbert.net/docs/sentence_transformer/pretrained_models.html)
- [sbert.net efficiency guide](https://sbert.net/docs/sentence_transformer/usage/efficiency.html)
- MTEB retrieval scores: public leaderboard as of 2025
- HuggingFace Xenova org for ONNX ports: https://huggingface.co/Xenova
