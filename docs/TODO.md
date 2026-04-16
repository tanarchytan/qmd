# QMD TODO — Optimization Phases

> Last updated: 2026-04-16 (RRF restructure + rerank sweep).
>
> **Reading order:** Current phase first, then future phases, then backlog.
> Each phase has pass/fail gates — if a phase fails, skip to the next or
> fall back to the current best.

---

## Current best (2026-04-16)

| Config | rAny@5 | R@5 | MRR | NDCG@10 | pref MRR |
|---|---|---|---|---|---|
| No rerank (RRF 0.9/0.1) | 97.8% | 93.3% | 0.918 | 0.916 | 0.741 |
| + rerank 0.1/0.9 (old additive) | 98.6% | 94.7% | 0.937 | 0.933 | 0.761 |

vs competitors: agentmemory 95.2% rAny@5, 0.882 MRR | MemPalace 96.6% rAny@5.

---

## Completed phases

### Phase 1: Restructure scoring pipeline
- [x] Replace additive fusion with rank-based RRF (A→B→C→D→E→F stages)
- [x] Dynamic injection scores (median, not hardcoded 0.5/0.25)
- [x] Clean stage separation (retrieval → fusion → boosts → sort → rerank → post)
- [x] Committed `734e357`

### Phase 2: Diagnose vec independently
- [x] Vec is weak (mxbai-embed-xsmall-v1 384d q8)
- [x] More vec weight collapses single-session-user (86% at 0.4/0.6 vs 99% at 0.9/0.1)
- [x] Answered by RRF weight sweep — no separate diagnostic needed

### Phase 3: Sweep RRF weights
- [x] Bracket + bisect: 1.0/0.0, 0.9/0.1, 0.8/0.2, 0.7/0.3, 0.4/0.6
- [x] Winner: 0.9/0.1 (BM25-heavy). n=500: 97.8% rAny@5, 0.918 MRR
- [x] Preference MRR improved +2pp vs old additive (0.741 vs 0.721)

### Rerank blend sweep (pre-restructure, on old additive)
- [x] Swept 0.0/1.0 through 0.6/0.4 at n=500
- [x] Winner: 0.1/0.9 (MRR 0.937, pref MRR 0.761)
- [x] 0.0/1.0 cliff: s-user 100→77% — 10% original weight is critical tiebreaker
- [x] Proves first-stage score is mostly noise, cross-encoder does real ranking

---

## Active phases

### Phase 4: Test RAW=off boosts
- [ ] n=500 RAW=off on new RRF pipeline (RUNNING)
- [ ] Measures impact of keyword boost, quoted phrase, decay, temporal boost
- [ ] Pass: clear delta vs RAW=on
- [ ] Fail: no signal → boosts are no-ops on LME

### Phase 5: Re-sweep rerank blend on RRF pipeline
- [ ] Bracket: 0.5/0.5 and 0.1/0.9 extremes
- [ ] Bisect toward optimal
- [ ] Pass: best ≥ old additive 0.1/0.9 (MRR ≥ 0.937)
- [ ] Fail: keep 0.1/0.9, cross-encoder dominates regardless of first-stage

---

## Future phases

### Phase 6: Fact-augmented embedding keys
Make vec useful. LME paper found +4% recall from fact-augmented keys.

- [ ] Design extraction step: LLM or pattern-based → "category: key fact"
- [ ] Embed augmented key instead of raw memory text
- [ ] Re-ingest LME dataset with new keys
- [ ] Re-sweep RRF weights (vec should now contribute meaningfully)
- [ ] Re-sweep rerank blend

**Why this matters:** current mxbai-xs embeddings can't distinguish
between semantically similar sessions. Augmented keys like "food
preference: prefers pasta over rice" are closer to how queries are
phrased than raw "user: I prefer pasta over rice" text.

### Phase 7: LLM-judge QA accuracy eval mode
Required for Supermemory/Hindsight comparison.

- [ ] Port LongMemEval `evaluate_qa.py` pattern
- [ ] Retrieve → generate answer with LLM → judge correctness
- [ ] ~1-2h implementation + LLM budget (~2000 calls per n=500 run)
- [ ] Produces numbers comparable to Supermemory 81.6% / Hindsight 91.4%

### Phase 8: Larger reranker model experiment
Current: ms-marco-MiniLM-L-6-v2 (22M params, ~5-10ms/pair).

- [ ] Test ms-marco-MiniLM-L-12-v2 (larger, slower, potentially better)
- [ ] Test bge-reranker-v2-m3 (multilingual, SOTA on MTEB)
- [ ] A/B at n=500 against current reranker

---

## Backlog (shipped but untested / low priority)

### Already shipped, never evaluated at n=500

| Feature | Gate | Status |
|---|---|---|
| Hindsight reflect synthesis | `memoryReflect()` API | Not wired into eval |
| Periodic reflection pass | `runReflectionPass()` API | Not wired |
| Push Pack | `pushPack()` API | Not wired |
| Tier-grouped recall | `runTieredRecall()` | Untested as lever |
| Per-turn ingest | `QMD_INGEST_PER_TURN=on` | Untested at any size |

### Architecture backlog

- [ ] Split `src/cli/qmd.ts` (54 nodes, cohesion 0.08 per graphify)
- [ ] Pluggable storage backend (`MemoryBackend` interface)
- [ ] Two-tier recall + archival (Letta/MemGPT pattern)
- [ ] Three-tier subgraph (Zep/Graphiti pattern)
- [ ] GraphRAG community summaries over KG
- [ ] Per-turn ingest A/B (changes substrate from ~50 to ~500 memories/scope)

### Technique parity with reference systems

- [ ] 4-parallel-path retrieval (Hindsight: semantic + BM25 + entity graph + temporal)
- [ ] Synonym expansion in BM25 (agentmemory has this)
- [ ] RAPTOR pre-ingest recursive abstractive tree
- [ ] Three-tier scope hierarchy (Mem0: session/user/agent)
- [ ] Cross-session signal routing (Tinkerclaw Round Table)

### Parked (proven no signal on current bench)

- [x] ~~QMD_MEMORY_EXPAND=keywords~~ — flat on preference sr5
- [x] ~~QMD_MEMORY_MMR=session~~ — flat on LME (byte-identical)
- [x] ~~kMultiplier 3→10~~ — byte-identical (vec is noise)
- [x] ~~RRF refactor (old attempt, pre-restructure)~~ — net loss, superseded
- [x] ~~HyDE / generative query expansion~~ — coverage already 100%
- [x] ~~Wider candidate pool~~ — top-40 already contains correct sessions

---

**When to update:** after every phase completion, every n=500 A/B that
changes the default config, or when a new optimization opportunity is
identified. Keep phase status accurate — next session depends on it.
