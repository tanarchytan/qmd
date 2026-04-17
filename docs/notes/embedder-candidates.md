# Embedder candidates — Phase 11 planning

Rule: **int8 ONNX required**, **≤1024 dim** (or Matryoshka-truncatable to ≤1024).

## Already tested on LME

Benchmarks against LongMemEval _s. Scores are the period's best; the 2026-04-13 numbers used the old additive pipeline (before RRF restructure).

### Succeeded (benchmarked)

| Model | Dim | Size (q8) | ONNX int8 | LME R@5 | LME MRR | multi-R@5 | Wall | Verdict |
|---|---|---|---|---|---|---|---|---|
| **mixedbread-ai/mxbai-embed-xsmall-v1** | 384 | ~50 MB | ✅ native | 94.2% (old), 98.4% (new) | 0.857 → 0.917 | 82% | 14m49s | **Production default** |
| Xenova/all-MiniLM-L6-v2 (file=`model_quint8_avx2`) | 384 | ~23 MB | ✅ Xenova | 94.4% | 0.859 | 83% | 17m09s | Viable fallback |
| sentence-transformers/all-MiniLM-L6-v2 (fp32 via fastembed, not q8) | 384 | ~90 MB | n/a | 93.2% | 0.862 | 81% | 23m33s | Too slow (fp32) |
| Snowflake/snowflake-arctic-embed-s q8 | 384 | ~35 MB | ✅ | 93.2% | — | 84.2% | — | **Strictly worse than mxbai-xs on every sr5 bucket.** Pref -10pp. Parked 2026-04-14 post metric-audit. |
| intfloat/multilingual-e5-small | 384 | — | ✅ | n/a (toy probe only) | — | — | — | Weak spread on probe, not LME-tested |

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
QMD_TRANSFORMERS_EMBED=<candidate> QMD_TRANSFORMERS_DTYPE=q8 \
QMD_EMBED_BACKEND=transformers QMD_VEC_MIN_SIM=0.1 \
QMD_RECALL_RAW=on QMD_INGEST_EXTRACTION=off QMD_INGEST_REFLECTIONS=off \
QMD_INGEST_SYNTHESIS=off QMD_INGEST_PER_TURN=off QMD_EMBED_MICROBATCH=64 \
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
