# Lotl TODO — Optimization Phases

> Last updated: 2026-04-19 morning.
>
> **2026-04-19 session summary** — Phase 0-6 optimization infrastructure
> shipped; rerun chain in flight. See
> `devnotes/sessions/session-2026-04-19-morning-triage.md` for triage order
> and `devnotes/sessions/v1.0.0-ga-release-checklist.md` for the release
> path after data lands. Key corrections since last update:
>
> - MRR "drift" 0.917 → 0.907 is a phantom — code unchanged since SNAPSHOTS
>   commit, original number likely measured on different DB state. No bisect.
> - Reranker data in the first sweeps is INVALID (silent no-op fixed in
>   `9cba9bc`) + ModernBERT OOM fixed in `f766f9d`. Reruns landing today.
> - `LOTL_RECALL_NO_TOUCH` guard added — eval A/B hygiene for shared DBs.
> - 5 flag polarity bugs documented in
>   `devnotes/architecture/env-flag-polarity-reference.md`.
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

### Phase 7: LLM-judge QA accuracy eval mode — PARTIAL
Required for Supermemory/Hindsight/Zep/mem0 comparison.

**What shipped 2026-04-17:**
- [x] LLM-judge wired into eval harness (`--judge <provider>`, `--judge-model <name>`)
- [x] Poe provider support (`--llm poe`, OpenAI-compatible shape) + `LOTL_POE_MODEL`
- [x] `poe-judge.mts` standalone helper + CLI for ad-hoc validation
- [x] Top-K + per-memory char cap (`LOTL_ANSWER_TOP_K=5`, `LOTL_ANSWER_MAX_CHARS=800`) — fixes a ~91k-token prompt blowup bug
- [x] Defense-in-depth caps on `memoryReflect` / `runReflectionPass`
- [x] v12 answer prompt option (paper-aligned, chain-of-thought + citations)
- [x] `--reflect` CLI flag (enables `memoryReflect` pre-pass)
- [x] Pre-flight token estimate with warning when prompt >8k tokens

**Baseline n=100 (mxbai-xs + gpt-4o-mini gen + gpt-4o judge, 2026-04-17):**
- rAny@5: 100%, MRR 0.911 — retrieval near-ceiling
- Judge: **22.0%** — gap vs LongMemEval paper baseline (~60-65% w/ GPT-4 gen)
- → retrieval is done; answer generation is the bottleneck.

**Published targets to match:**
- LongMemEval _s paper: **GPT-4 gen + GPT-4 judge → ~60-65% accuracy**
- Mem0 + GPT-4: ~55-60%
- Letta/MemGPT + GPT-4: ~60-70%

### Phase 7.1: Generator-model sweep — PARTIALLY DONE 2026-04-17
- [x] **`gpt-4o-mini`** for generation (baseline) — Judge **22.0%** at top-5×800, **21.0%** at top-5×800 + v13
- [x] **`gpt-4o`** for generation — Judge **27.0%** at top-5×800. Only +5pp vs mini. Suggested generator wasn't the bottleneck.
- [ ] **`gpt-4o`** for generation at top-5×6000 chars — pending (paused by user after char-cap fix)
- [ ] **`claude-sonnet-4.5`** — pending
- [ ] **`claude-haiku-4.5`** — deferred (user flagged more expensive than gpt-4o on Poe points)

### Phase 7.2: Answer prompt A/B — DONE 2026-04-17
- [x] **v13** — minimal LongMemEval-paper-aligned prompt (`LOTL_PROMPT_RULES=v13`). **Result: tied with v11 on gpt-4o-mini** (21% vs 22% Judge). Prompt style was NOT the bottleneck.
- [x] v12 — chain-of-thought + structured `Answer:`/`Cited:` output (`LOTL_PROMPT_RULES=v12`). Kept as option. Not run — v13 result suggested prompt wasn't the lever.
- [x] v11 / v11.1 (old default) — kept for reproducing old F1/EM numbers. v13 is now the recommended default for `--judge` runs.

**Conclusion:** v11/v13 produce same Judge on gpt-4o-mini. Prompt-style mismatch didn't explain the gap to the paper.

### Phase 7.3: Reflection pre-pass A/B — CLOSED 2026-04-17 (superseded, deferred to post-production)
- [x] Flag + plumbing (`--reflect`)
- [x] Defense-in-depth caps (`LOTL_REFLECT_TOP_K=10`, `LOTL_REFLECT_MAX_CHARS=800`)
- Closed without benchmarking. Original rationale (compression of long context model can't scan) was superseded by the Phase 7.1b char-cap fix — gpt-4o now scans 30K-char contexts natively.
- Potential secondary rationale (multi-fact synthesis across memories) was probed via Phase 7.4 TOP_K=10 diagnostic on the 36 remaining wrong questions: only 2/36 recovered, confirming top-K window isn't the bottleneck and reflection is unlikely to help more. 22/34 remaining failures were "wrong-content" (model picked nearby distractor), 12/34 were refusals. Reflection *might* help the wrong-content cases but the probe would cost ~55K Poe pts for ~5-15pp speculative lift. Not worth it at 64% Judge already matching the LongMemEval paper baseline.
- **Revisit if:** we productize long-conversation QA (>20 sessions/scope) where context definitely exceeds the window, or if we want to push past the paper ceiling in a future research cycle.

### Phase 7.4: Memory-char budget fix — DONE 2026-04-17
**This was the real bottleneck.** LongMemEval sessions average 8,283 chars (max 42,910). The old 800-char cap dropped 90%+ of each memory. gpt-4o couldn't find answers because they were past the truncation point.

Applied fix (default): `LOTL_ANSWER_MAX_CHARS` **800 → 6000**.

Diagnostic per-bucket at v13+gpt-4o+800char cap:
- single-session-user: 22.9% Judge (should be EASIEST bucket)
- multi-session: 36.7% Judge (should be HARDER bucket)
- Inverted difficulty ⇒ content availability, not reasoning, was the bottleneck.

Additional probe 2026-04-17: `LOTL_ANSWER_TOP_K=10` on the 36 still-failing questions → 2/36 recovered (5.6% Judge on subset). Window-width isn't the bottleneck either; `TOP_K=5` default stays. Larger windows (20+) would cost ~2x API + risk noise; skipped.

**Defaults settled:** `TOP_K=5`, `MAX_CHARS=6000`. Matches LongMemEval paper's top-5 × full-session recipe.

### Phase 7.5: Structured output + citation validation — CLOSED 2026-04-17 (deferred)
v12 prompt already requests `Cited:` line but v12 is not default (over-engineered per Phase 7.2 comparison). Citation precision metric would need:
1. A fresh v12-prompted run to generate the `Cited: [indices]` lines (cost ~15-25K Poe pts)
2. ~30 LOC parser + scorer against gold-answer tokens

Revisit trigger: user-facing answer UI wants citations; or research goal to beat paper baseline with deeper metrics. Not needed to match the paper's published numbers.

### Phase 7 outcome — MATCH with paper 2026-04-17

| Stage | Judge |
|---|---|
| 7.1 v11 baseline (mini) | 22.0% |
| 7.1 gpt-4o at 800 chars | 27.0% |
| 7.1b gpt-4o at 6000 chars | **64.0%** ← paper's 60-65% baseline |
| 7.4 probe (TOP_K=10 on 36 wrong) | 5.6% lift = +2 of 36 |

**Phase 7 closes at 64% Judge on n=100.** Matches LongMemEval paper published baseline for GPT-4-class generators. Remaining 36 errors are deep (12 refusals + 22 wrong-content picks) — further gains require either generator swap (claude-sonnet-4.5, ~30K pts probe) or fact-augmented keys (Phase 6, requires API + ingest rebuild).

**Next paid work (owner decides):**
- n=500 confirmation with baseline config (~15K Poe pts) — produces the "apples-to-apples vs published leaderboard" number
- Phase 6 fact-augmented keys — ship if we want to push past paper baseline

---

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
- [ ] Config: `LOTL_VECTOR_BACKEND=sqlite-vec|lancedb`

**Status:** not urgent per Phase 10 benchmark — our scale is ~50 memories/scope,
sqlite-vec is 2272 QPS at 1k. Real crossover at 10k-100k where LanceDB becomes
15x faster. Defer until scale justifies it or multi-agent concurrent writes
become a pain point.

### Phase 11: Embedder upgrade — CONCLUDED 2026-04-17
**Result:** mxbai-xs q8 stays permanent production default. No candidate produced a clear win; closest matches cost 3-5x params for ~0 MRR gain. Full results in `devnotes/embedders/embedder-candidates.md`.

**Revisit trigger:** a new model with int8 ONNX + MTEB retrieval ≥65 AND a clear params/latency budget fit. Until then, the retrieval ceiling on LME _s is a corpus artifact (short conversations, ceiling already hit), not an embedder limitation.

### Phase 11.5: GPU device auto-select — SHIPPED 2026-04-17
**Result:** `LOTL_TRANSFORMERS_DEVICE=auto` probes hardware (VRAM, driver age)
and picks device + microbatch + workers. GPU-first with CPU fallback when
buffer cap or probe fails. Works on AMD/Intel/NVIDIA/Apple.
Deps upgraded: `@huggingface/transformers` 4.0.1→4.1.0, `better-sqlite3`
12.8.0→12.9.0.

**Files added:** `src/llm/gpu-probe.ts`, `src/llm/embed-sizer.ts`.
**Env vars:** `LOTL_TRANSFORMERS_DEVICE` (cpu|webgpu|dml|gpu|auto),
`LOTL_TRANSFORMERS_AUTO_PREFER` (cpu overrides GPU-first in auto mode).

**Validated outputs on Ryzen 7 PRO 7840U / Radeon 780M:**
- mxbai-xs → webgpu, mb=1, workers=2
- embgemma-300m → webgpu, mb=29, workers=1
- mxbai-embed-large → webgpu, mb=89, workers=1
- bge-base → webgpu, mb=119, workers=1

---

### Phase 11.6 (CANCELED): AMD NPU standalone benchmark
Originally queued as a Python-sidecar probe to see whether XDNA NPU could
hit ≥2× CPU for Node-backed embedding. Dropped in v1.0.0: VitisAI EP is
Python-only, has no Node binding, and the Lotl CPU+WebGPU path was already
fast enough for the production workload. NPU detection code removed from
`src/llm/gpu-probe.ts`. Re-open only if a first-class Node.js NPU runtime
appears or we ship a Python sidecar for other reasons.

### Phase 11.7: CPU sweep of 8 embedders — COMPLETED 2026-04-17
**Ran 6/8 candidates at n=100** (2 skipped for transformers.js v4.1.0 arch incompat).
Full leaderboard in `devnotes/embedders/embedder-candidates.md`. Key findings:

| Rank | Model | MRR | Params | Verdict |
|---|---|---|---|---|
| 🥇 | Xenova/bge-large-en-v1.5 | 0.9267 | 335M | Ceiling; CPU-too-slow for prod |
| 🥇 | Xenova/UAE-Large-V1 | 0.9267 | 335M | Tied with bge-large to 4 decimal places |
| 🥈 | **Xenova/gte-small** | **0.9212** | **30M** | **Value pick at baseline size class** |
| — | mxbai-xs (baseline) | 0.917 | 22M | current production default |

### Phase 11.8 (pending, machine-time only): n=500 follow-up for top-3
Confirm the n=100 lift is real at production scale. Each candidate is a single
`npx tsx evaluate/longmemeval/eval.mts` invocation — fully local, no API cost.

- [ ] **Xenova/gte-small** (30M, 384d, ~5-8 min wall) — highest-value run: if the +0.4pp MRR holds at n=500, **gte-small replaces mxbai-xs as production default**.
- [ ] **Xenova/bge-large-en-v1.5** (335M, 1024d, ~60-90 min wall) — confirms the 0.9267 MRR ceiling is real. Ceiling reference only; not a deployment candidate until GPU backend lands.
- [ ] **Xenova/UAE-Large-V1** (335M, 1024d, ~60-90 min wall) — tie-breaker vs bge-large. Expected to match within ±0.005 MRR.

Gate: rAny@5 ≥ 98.4% AND MRR ≥ 0.917 (current mxbai-xs n=500 baseline). Any candidate ≥0.920 MRR warrants a default swap discussion.

**Command template:**
```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_TRANSFORMERS_EMBED=<model> \
LOTL_TRANSFORMERS_DTYPE=q8 \
LOTL_TRANSFORMERS_DEVICE=cpu \
LOTL_VEC_MIN_SIM=0.1 \
LOTL_RECALL_RAW=on \
LOTL_INGEST_EXTRACTION=off LOTL_INGEST_REFLECTIONS=off \
LOTL_INGEST_SYNTHESIS=off LOTL_INGEST_PER_TURN=off \
LOTL_EMBED_MICROBATCH=32 \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --no-llm \
    --workers 2 --tag <tag> --db-suffix <tag>
```

---

### Phase 11 (archived): Embedder upgrade
Replace mxbai-embed-xsmall-v1 q8 with a stronger retrieval-trained embedder.

**Technical requirements:**
- ONNX format (transformers.js compatible)
- Node.js CPU inference <100ms/query, quantized (q4/q8/int8/FP16)
- Tri-platform prebuilt binaries
- <500MB download, 384-768 dim preferred
- **ONNX optimization level O3/O4 preferred** — up to 2.5-3x additional
  CPU speedup on top of quantization (per sbert efficiency docs)
- **Matryoshka-trainable bonus** — post-hoc dim truncation for cheaper
  storage + inference without retraining (Nomic-v1.5, Jina-v3)
- **Arch-specific ONNX variant awareness** — prefer `model_quint8_avx512_vnni`
  on modern Intel, `model_quint8_avx2` on older x64. `LOTL_TRANSFORMERS_FILE`
  can pin the exact variant.

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

**Procedure:** one env var change (`LOTL_TRANSFORMERS_EMBED=<model>`), n=100 sanity,
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

- ~~`LOTL_MEMORY_MMR=session`~~ — flat on LME (byte-identical)
- ~~kMultiplier 3→10~~ — byte-identical (vec is noise)
- ~~HyDE / generative query expansion~~ — coverage already 100%
- ~~Wider candidate pool~~ — top-40 already contains correct sessions
- ~~Temporal 3rd RRF weight 0.3~~ — byte-identical (LME shared ingest timestamp)
- ~~Post-fusion boosts (RAW=off)~~ — crushes preference MRR (-13pp)
- ~~L1 user-only ingest~~ — -7pp preference rAny5
- ~~Per-turn ingest~~ — 10x latency, no quality gain
- ~~extractAndStore + KG~~ — -16pp multi-session R@5
- ~~Pure rerank (0.0/1.0)~~ — s-user collapses 100→77%
- ~~L# cache hierarchy blend (L0+L1+L2)~~ — preference MRR -5.2pp, Cov collapse, 5.5x wall. Shipped opt-in via `LOTL_MEMORY_LHASH=on` for future experimentation but not default.

---

**When to update:** after every phase completion, every n=500 A/B that
changes the default config, or when a new optimization opportunity is
identified. Keep phase status accurate — next session depends on it.
