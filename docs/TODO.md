# QMD TODO — Optimization Phases

> Last updated: 2026-04-17 late (L# parked, vector-bench done, embedder research queued).
>
> **Reading order:** Current best → completed → pending → backlog → parked.
> Each pending phase has pass/fail gates.

---

## Current best (2026-04-17, n=500 LongMemEval _s)

| Config | rAny@5 | R@5 | MRR | NDCG@10 | pref MRR |
|---|---|---|---|---|---|
| **No rerank (RRF 0.9/0.1 + expand + synonyms)** | **98.4%** | **93.7%** | **0.917** | **0.913** | **0.745** |
| + rerank on new RRF (normalized 0.7/0.3) | 98.0% | 93.8% | 0.911 | 0.912 | 0.740 |

vs competitors: agentmemory 95.2% / 0.882 MRR | MemPalace 96.6% rAny@5.

---

## Completed phases

| # | Phase | Result |
|---|---|---|
| 1 | Restructure scoring pipeline | Rank-based RRF, A→F staged. Commit `734e357` |
| 2 | Diagnose vec independently | Vec weak (mxbai-xs), more vec collapses s-user |
| 3 | Sweep RRF weights | Winner 0.9/0.1 BM25-heavy |
| 4 | Test RAW=off boosts | -13pp pref MRR → RAW=on stays eval default |
| 5 | Re-sweep rerank blend on RRF | 0.7/0.3 (normalized). Rerank near-neutral on proper RRF |
| 5.1 | RRF normalization for rerank | Min-max to [0,1] both sides. Commit `dcb200d` |
| 5.5 | Temporal 3rd RRF + keyword expansion | Temporal no-op on LME. Keyword expansion WINS (+4pp pref). Commit `919188e` |
| 5.6 | L1 user-only ingest | +0.7pp MRR but -7pp pref → parked |
| 5.7 | Synonym expansion in BM25 | +0.8pp pref MRR. Shipped default. Commit `18594cf` |
| 5.8 | Per-turn ingest | 10x latency, no quality gain → parked |
| 5.9 | L# blend (L0+L1+L2) | n=500: -0.6pp recall, -5.2pp pref MRR, 5.5x wall → **parked opt-in**. Commit `75814ac` |
| 6.5 | extractAndStore + KG injection | -16pp multi-session → parked. Metadata bug fixed (`bee34d7`) |
| 10 | node-vector-bench on our hw | Crossover at ~10k-100k. LanceDB backend valid but not urgent |
| MCP tooling | Wire memoryRecallTiered + memoryPushPack | Commits `da317fa` + `4294981` |

---

## Pending phases

### Phase 6: Fact-augmented embedding keys
Make vec useful. LME paper found +4% recall from fact-augmented keys.

- [ ] Design extraction step: LLM or pattern-based → "category: key fact"
- [ ] Embed augmented key instead of (or alongside) raw memory text
- [ ] Re-ingest LME dataset with new keys
- [ ] Re-sweep RRF weights (vec should now contribute meaningfully)

**Why this matters:** current mxbai-xs embeddings can't distinguish
semantically similar sessions. Augmented keys like "food preference:
prefers pasta over rice" are closer to query phrasing than raw
conversation text.

**Pass criteria:** vec-heavy RRF (0.5/0.5 or better) should beat
BM25-heavy (0.9/0.1) on preference MRR. If flat, fact-augmented
keys not worth the ingest cost.

### Phase 7: LLM-judge QA accuracy eval mode
Required for Supermemory/Hindsight/Zep/mem0 comparison.

- [ ] Port LongMemEval `evaluate_qa.py` pattern
- [ ] Retrieve → generate answer with LLM → judge correctness
- [ ] ~1-2h implementation + ~2000 API calls per n=500 run
- [ ] Produces numbers directly comparable to published leaderboard

**API cost estimate:** ~€5-10 per n=500 run on Gemini Flash Lite.

### Phase 8: Larger reranker model
Current: `ms-marco-MiniLM-L-6-v2` (22M params, ~5-10ms/pair).

- [ ] Test `ms-marco-MiniLM-L-12-v2` (larger)
- [ ] Test `bge-reranker-v2-m3` (MTEB SOTA)
- [ ] Test `mixedbread-ai/mxbai-rerank-large-v2`

**Why relevant:** current rerank on proper RRF is near-neutral.
A better cross-encoder might actually help across the board.

### Phase 9: LanceDB as second MemoryBackend adapter
Swap sqlite-vec for LanceDB when users hit scale or need concurrent writes.

- [ ] Define `MemoryBackend` interface (modeled on Mem0 `VectorStoreBase`)
- [ ] Extract current sqlite-vec path behind `SqliteVecBackend` class (zero behavior change)
- [ ] Write `LanceDBBackend` using `@lancedb/lancedb` (bundle `apache-arrow` transitively)
- [ ] Keep SQLite for FTS + metadata, two-DB join by `id`
- [ ] Benchmark both at LME n=500 (must hold 98.4% rAny@5)
- [ ] Stress test at 100k memories/scope
- [ ] Config: `QMD_VECTOR_BACKEND=sqlite-vec|lancedb`

**Status:** not urgent per Phase 10 benchmark — our scale is ~50 memories/scope,
sqlite-vec is 2272 QPS at 1k. Real crossover at 10k-100k where LanceDB becomes
15x faster. Defer until scale justifies it or multi-agent concurrent writes
become a pain point.

### Phase 11: Embedder upgrade
Replace mxbai-embed-xsmall-v1 q8 with a stronger retrieval-trained embedder.

**Technical requirements:**
- ONNX format (transformers.js compatible)
- Node.js CPU inference <100ms/query, quantized (q4/q8/int8/FP16)
- Tri-platform prebuilt binaries
- <500MB download, 384-768 dim preferred

**Quality gates at n=500 LongMemEval:**
- recall_any@5 ≥ 98.4% (current baseline floor)
- preference MRR > 0.80 (current 0.745)
- multi-session R@5 ≥ 90% (don't break what works)

**Candidates to test (retrieval-specific only):**
- [ ] BGE-base-en-v1.5 (768d, MTEB 63.5)
- [ ] mxbai-embed-large-v1 (1024d, MTEB 60.4, same family upgrade)
- [ ] Jina-embeddings-v3 (1024d, MTEB 66.7 — best open retrieval)
- [ ] Nomic-embed-text-v1.5 (768d, Matryoshka-trainable to 384d)
- [ ] Qwen3-Embedding-0.6B (1024d, recent pair-matching strength)

**Skip:** general-purpose, multilingual (English-only corpus),
multimodal (text-only), instructor (prefix burden), scientific (wrong domain).

**Procedure:** one env var change (`QMD_TRANSFORMERS_EMBED=<model>`), n=100 sanity,
then n=500 if recall holds. Zero code changes — pipeline is embedder-agnostic.
If wins, re-sweep RRF weights (expect shift toward vec-heavy).

---

## Backlog (low priority / deferred)

### Architecture
- [ ] Split `src/cli/qmd.ts` (54 nodes, cohesion 0.08 per graphify)
- [ ] Pluggable storage backend (`MemoryBackend` interface)
- [ ] Two-tier recall + archival (Letta/MemGPT pattern)
- [ ] Three-tier subgraph (Zep/Graphiti pattern)
- [ ] GraphRAG community summaries over KG

### Technique parity
- [ ] 4-parallel-path retrieval (Hindsight pattern)
- [ ] RAPTOR pre-ingest recursive abstractive tree
- [ ] Three-tier scope hierarchy (Mem0 pattern)
- [ ] Cross-session signal routing (Tinkerclaw Round Table)

### Shipped but unexercised by eval
- `memoryReflect` — post-retrieval LLM synthesis (API required)
- `runReflectionPass` — periodic reflection (API required)
- `memoryRecallTiered` — tier-grouped recall (unit tested, MCP wired 2026-04-17)
- `memoryPushPack` — pre-query bundle (unit tested, MCP wired 2026-04-17)

---

## Parked (proven no signal on LongMemEval)

- ~~`QMD_MEMORY_MMR=session`~~ — flat on LME (byte-identical)
- ~~kMultiplier 3→10~~ — byte-identical (vec is noise)
- ~~HyDE / generative query expansion~~ — coverage already 100%
- ~~Wider candidate pool~~ — top-40 already contains correct sessions
- ~~Temporal 3rd RRF weight 0.3~~ — byte-identical (LME shared ingest timestamp)
- ~~Post-fusion boosts (RAW=off)~~ — crushes preference MRR (-13pp)
- ~~L1 user-only ingest~~ — -7pp preference rAny5
- ~~Per-turn ingest~~ — 10x latency, no quality gain
- ~~extractAndStore + KG~~ — -16pp multi-session R@5
- ~~Pure rerank (0.0/1.0)~~ — s-user collapses 100→77%
- ~~L# cache hierarchy blend (L0+L1+L2)~~ — preference MRR -5.2pp, Cov collapse, 5.5x wall. Shipped opt-in via `QMD_MEMORY_LHASH=on` for future experimentation but not default.

---

**When to update:** after every phase completion, every n=500 A/B that
changes the default config, or when a new optimization opportunity is
identified. Keep phase status accurate — next session depends on it.
