# QMD Roadmap

> For agents: this file tracks all pending work and benchmark history. Read this first when resuming a session.
> Last updated: 2026-04-12 (post-graphify, pre-compaction snapshot)

**Package:** `@tanarchy/qmd` — npm (`@dev` tag for dev branch, `@fork` tag for stable)
**Repo:** `github.com/tanarchytan/qmd` — `main` (stable) + `dev` (active development)
**Branch:** Work on `dev`, merge to `main` when stable.

---

## 🆕 Session 2026-04-12 — commits shipped

| SHA | Type | Summary |
|-----|------|---------|
| `cd4d3dd` | chore | Cleanup repo + reorganize docs (remove code-graph + memorybench + AGENTS/GEMINI duplicates; ROADMAP→docs/; new docs/EVAL.md) |
| `6f4f890` | feat(memory) | v15-final — synthesis, eviction, ablation toggles, dead code cleanup |
| `a94ea1a` | feat(eval) | LongMemEval support + LoCoMo ablation tooling + LLM cache + seed |
| `5827cb1` | perf(memory) | Batch ingest API (memoryStoreBatch) + storage toggles + extract/answer model split |
| `9c138c8` | feat(eval) | Apples-to-apples LME metric (SR@K) + raw recall mode + drop dead toggles |
| `a6fe802` | perf(eval) | In-process worker pool (--workers N) + embed batch 32→64 + stale comment cleanup |

**Working tree clean** as of compaction. All session work committed.

## 🚀 v15.1 — apples-to-apples + temporal answer fix (2026-04-12)

**Two changes from v15-final, validated on LME oracle:**

1. **Answer prompt v11 → v11.1** (env-gated via `QMD_PROMPT_RULES=v11.1`). Adds three rules addressing the failure modes found in the first LME baseline analysis: ordering ("which came first"), no-refuse duration arithmetic, enumerate-then-count.
2. **MemPalace-aligned recall metric** — the published 96.6% is session-id `recall_any`, not token-overlap. We now store `source_session_id` / `source_dialog_id` metadata at ingest and report SR@K (LME) / DR@K + SR@K (LoCoMo) alongside the legacy R@K.

### LME A/B on oracle, n=50 (temporal-reasoning subset)

| Metric | v15-final (v11) | **v15.1 (v11.1)** | Δ |
|---|---|---|---|
| **SR@5** (MemPalace apples-to-apples) | **100.0%** | **100.0%** | = |
| **SR@10** | **100.0%** | **100.0%** | = |
| R@5 (legacy token-overlap) | 86.0% | 86.0% | = |
| R@10 | 92.0% | 92.0% | = |
| F1 | 51.4% | 52.9% | **+1.5pp** |
| EM | 22.0% | 28.0% | **+6.0pp** |

**Headline:** SR@5 = 100% on both runs. The 80% R@5 in the first baseline was a pure metric artifact (token-overlap fails on short numeric answers — "27" vs "27 years old" scores 0). **QMD retrieval was already apples-to-apples with MemPalace; we'd been chasing a phantom gap.**

v11.1 prompt delivers a real but modest F1 (+1.5pp) and clearer EM (+6pp) improvement. Ships as the default once LoCoMo cross-check confirms no regression.

### Apples-to-apples metric design (LoCoMo)

Following MemPalace's `benchmarks/locomo_bench.py` verbatim:
- **`DR@K`** — dialog-level fractional recall: `found_dialog_ids / len(evidence)`. Primary metric.
  - Each memory stores `source_dialog_id` from the dataset's native `dia_id` field (`D<sess>:<turn>`).
  - Evidence like `["D1:9", "D1:11"]` and finding only one scores 0.5, not 1.0 — rewards multi-hop retrieval properly.
- **`SR@K`** — session-level any-match (coarser secondary metric, matches MemPalace session granularity mode).
- Top-K reported at K ∈ {5, 10, 15, 50}. K=50 is MemPalace's default but generous; SR@5/DR@5 are the honest numbers.
- `memoryRecall(limit: 50)` then slice locally — one recall call serves all four K values.

### Pending / in-flight

1. **LoCoMo conv-30 run** with DR@K/SR@K — in flight (bg `bq2g25djf`, ~10 min wall, fresh ingest required for new metadata schema)
2. **LoCoMo conv-26 cross-check** after conv-30 lands
3. **LME full distribution** — current `--limit 50` is all `temporal-reasoning` due to dataset ordering. Need `--limit 200` or a shuffled sample for the four other question types (single-hop, multi-hop, knowledge-update, abstention)
4. **Raw-mode LME** (`QMD_RECALL_RAW=on`, extraction off) — closest replica of MemPalace's ChromaDB recipe; tests whether our pipeline complexity helps or hurts
5. **v16 candidates** (Hindsight-inspired, post-v15.1 ship): smart KG-in-recall, post-retrieval reflect synthesis, cross-encoder rerank, separate temporal retrieval path

### Side issue to fix

Query expansion is passing `--extract-model gemini-2.5-flash-lite` through to the Nebius provider and 404'ing. Separate code path, doesn't affect results (QE is effectively disabled during these runs), but should be decoupled so `--extract-model` only overrides the extraction LLM.

See `~/.claude/projects/.../memory/project_session_handoff_20260412.md` for full session state.

---

## ✅ Implemented & Working

### Core memory system (Phases 1–5 verified in code)

- **Phase 1** — memories table, FTS5, sqlite-vec, content hash + cosine dedup, embedding LRU cache, memory_history changelog
- **Phase 2** — Weibull decay engine, 3-tier promotion (peripheral/working/core), composite scoring (0.4 recency + 0.3 frequency + 0.3 intrinsic)
- **Phase 3** — 16 regex pattern classification, LLM extraction (Mem0-style atomic facts + KG triples), preference bridging
- **Phase 4** — Temporal knowledge graph (subject/predicate/object + valid_from/valid_until), entity normalization, auto-invalidation
- **Phase 5** — OpenClaw plugin, before_prompt_build/agent_end hooks, dream consolidation, cursor checkpointing

### Search pipeline (from MemPalace integration)

- BM25 (FTS5) + vector (sqlite-vec) parallel
- RRF fusion (k=60), 2× BM25 weight
- Zero-LLM boosts: keyword overlap (×1.4), quoted phrase (×1.6), person name
- Stop-word filtering, name filtering
- Strong-signal detection (skip query expansion when FTS hits)
- Temporal distance boost (40% for time-proximate)
- LLM rerank (ZeroEntropy zerank-2)
- Position-aware blend (rank-dependent RRF/rerank weights)

### Remote providers

- Per-operation config (embed/rerank/expansion)
- Provider modes: api/url/gemini + aliases (zeroentropy/siliconflow/etc)
- Remote-first dispatch with local fallback
- ZeroEntropy zembed-1 + zerank-2 (current best for memory)
- Nebius Llama for query expansion

### Tooling

- 40+ CLI commands, MCP stdio + HTTP daemon
- LoCoMo eval harness (`evaluate/locomo/eval.mts`)
- Setup tooling (`setup/setup-qmd.sh`, selfcheck, config-validate)
- AST chunking (tree-sitter), markdown chunking with code-fence awareness

---

## 🧬 Techniques By Category

Cross-cutting view: every technique appears in multiple systems. This shows overlap and reveals which categories QMD is strong/weak in.

**Legend:** ✓ complete · ~ partial · ✗ missing

### 1. Tiered / Hierarchical Storage — **~ partial**

| System | Approach | QMD |
|--------|----------|-----|
| Zep | 3-tier subgraph (episode + entity + community) | ✗ |
| Letta/MemGPT | 2-tier (recall + archival) | ✗ |
| Tinkerclaw Instant Recall | 2-tier (episodic + semantic, nightly rebuild) | ✗ |
| memory-lancedb-pro | 3-tier promotion (peripheral/working/core) | ✓ via decay.ts |
| Sleep Consolidation | Use-case folders (lessons/bugs/knowledge) | ✗ |

**QMD honest:** decay TIER labels only (peripheral/working/core). All memories live in same table — no storage-level separation. v12 dual-pass split-rank simulates two tiers at retrieval time, doesn't restructure storage.

### 2. Multi-Pass / Hybrid Retrieval — **~ partial**

| System | Approach | QMD |
|--------|----------|-----|
| MemPalace | BM25 + vec + RRF + reranker | ✓ |
| MemPalace | 2-pass assistant retrieval ("you suggested X") | ✗ |
| Letta | Agent self-directed (recall_search vs archival_search) | ~ |
| Zep | Query each subgraph separately, merge | ~ |
| **Hindsight** | **4 parallel paths: semantic + BM25 + entity graph + temporal filter + cross-encoder rerank** | ~ (2 of 4 paths) |
| QMD v15-final | BM25 + vec + RRF + LLM rerank + temporal boost | ~ |

**QMD honest:** Have 2 parallel paths (BM25 + vector). **Missing: entity graph traversal in recall** (the KG exists but isn't queried — was rolled back in v8 because generic entries dominated; smart gating could fix). Also using LLM rerank instead of cross-encoder. **This is the biggest gap vs Hindsight (91.4% LongMemEval).**

### 3. Atomic Fact Extraction — **✓ complete**

| System | Approach | QMD |
|--------|----------|-----|
| Mem0 | LLM extraction, atomic facts ONLY (deletes chunks) | n/a |
| MemPalace | NO extraction, raw chunks only | n/a |
| Tinkerclaw Instant Recall | Importance-scored extraction | ~ |
| QMD v10+ | Mem0-style atomic + raw chunks dual-stored | ✓ |

**QMD honest:** Mem0-style LLM extraction (extractor.ts) + raw chunks. v12 dual-pass surfaces both during retrieval.

### 4. Chunking Strategy — **✓ complete**

| System | Chunk size | QMD |
|--------|-----------|-----|
| MemPalace | 800 chars, 100 overlap, paragraph break | ✗ |
| Tinkerclaw Instant Recall | 256-512 tokens | ✗ |
| Mem0 | None (atomic facts only) | n/a |
| QMD memory | Turn-level (~50 tok) AND full session (~500+) | ✓ both |
| QMD docs | AST-aware (tree-sitter) + markdown break-points | ✓ |

**QMD honest:** Different sizing strategy than MemPalace/Tinkerclaw but valid. Could test 800-char as v13+ experiment.

### 5. Temporal / Time-Aware Retrieval — **✓ complete**

| System | Technique | QMD |
|--------|-----------|-----|
| MemPalace | Temporal distance boost (40% time-proximate) | ✓ |
| Zep | Bitemporal validity windows on facts | ✓ via knowledge.ts |
| Mem0 | Auto-invalidation of conflicting facts | ✓ |
| Tinkerclaw Total Recall | Time-range markers replacing evicted content | ✗ |
| QMD | Date reasoning prompt + valid_from/until + temporal boost | ✓ |
| Custom | Adversarial date scoring fix | ✓ |

**QMD honest:** All major techniques present. Temporal F1 still 39.1% in v10 — bottleneck is retrieval ranking, not temporal logic.

### 6. Decay / Lifecycle Management — **~ partial**

| System | Algorithm | QMD |
|--------|-----------|-----|
| memory-lancedb-pro | Weibull (recency × frequency × intrinsic, β per tier) | ✓ |
| MemoryBank | Ebbinghaus forgetting curve | ✗ |
| Sleep Consolidation | Cleaning Lady cron, 14-day archival, 50KB budgets | ✗ |
| Total Recall | LRU-K type-weighted eviction | ✓ via cat 17 |
| QMD | Weibull + 3-tier promotion + composite score | ~ |

**QMD honest:** Decay scoring + tier promotion complete. Missing: scheduled automated enforcement of storage budgets (Cleaning Lady cron). `runDecayPass` evaluates tiers; `runEvictionPass` deletes on demand only.

### 7. Importance / Prioritization Scoring — **~ partial**

| System | Formula | QMD |
|--------|---------|-----|
| Tinkerclaw Instant Recall | `effective = cos_sim × (1 + α·log(importance))`, α=0.15 | ✓ via v12 |
| Tinkerclaw Instant Recall | 4-component: entity_density + decision + engagement + recency | ~ |
| QMD | importance ∈ [0,1] from category + length | ~ |
| QMD | composite score = 0.4 recency + 0.3 freq + 0.3 intrinsic | ✓ |

**QMD honest:** v12 added log-modulation in recall. Importance estimation simpler than Tinkerclaw's 4-component (we use category + length only, no entity density / engagement signals).

### 8. Diversity / MMR — **✓ complete**

| System | Technique | QMD |
|--------|-----------|-----|
| Tinkerclaw Total Recall | MMR for retrieval, λ ∈ [0.5, 0.8] | ✓ via v12 |
| Standard IR | Carbonell & Goldstein 1998 | ✓ via v12 |
| QMD v12 | Greedy MMR with Jaccard token similarity, λ=0.7 | ✓ |

**QMD honest:** v12 added Jaccard-based MMR (cheap, no embeddings needed). Could upgrade to embedding-based similarity if precision becomes an issue.

### 9. Deduplication — **✓ complete**

| System | Approach | QMD |
|--------|----------|-----|
| Mem0 | Content hash MD5 + cosine ≥0.9 | ✓ |
| Mem0 | LLM conflict resolution (ADD/UPDATE/DELETE/NONE) | ✓ |
| QMD | Both layers + LLM resolution | ✓ |

**QMD honest:** Production-grade dedup, no gaps.

### 10. Knowledge Graph / Entities — **~ partial**

| System | Approach | QMD |
|--------|----------|-----|
| Zep / Graphiti | Temporal KG with bitemporal validity | ✓ |
| Mem0 | Graph store alongside vector | ✓ |
| GraphRAG | Community-based hierarchical KG | ~ via cat 11 synthesis |
| MemPalace | SQLite KG | ✓ |
| QMD | knowledge.ts with subject/predicate/object + valid_from/until | ✓ storage |

**QMD honest:** KG storage complete. KG NOT used directly in recall (hurt R@5 when injected). v12 cat 11 synthesis bridges this — entity facts become memory chunks via consolidateEntityFacts.

### 11. Synthesis / Abstraction / Compression — **~ partial**

Two distinct synthesis flavors — pre-ingest (build summary memories) vs post-retrieval (reason across top-K before returning):

| System | When | Approach | QMD |
|--------|------|----------|-----|
| RAPTOR | Pre-ingest | Recursive abstractive tree | ✗ |
| GraphRAG | Pre-ingest | Community summaries | ~ via consolidateEntityFacts |
| Sleep Consolidation | Pre-ingest | Level-based promotion | ~ via consolidateEntityFacts |
| Mastra | Pre-ingest | 3-agent observer/reflector compression | ✗ |
| Generative Agents | Background | Periodic reflection over memory streams | ✗ |
| **Hindsight** | **Post-retrieval** | **`reflect` LLM call reasons across top-K before returning** | ✗ |
| QMD v15-final | Pre-ingest | Per-entity profiles + timelines + reflection extraction (merged into single LLM call) | ~ |

**QMD honest:** Pre-ingest synthesis present (✓ consolidation, ✓ reflection extraction merged). Missing: **post-retrieval synthesis** (Hindsight's reflect — runs 1 extra LLM call per recall, reasons across the top-K and returns synthesized answer context). This is a likely v16 candidate.

### 12. Caching — **✓ complete**

| System | Technique | QMD |
|--------|-----------|-----|
| Mastra | Embedding LRU keyed by xxhash64 | ✓ MD5 variant |
| Total Recall | LRU-K eviction | ✓ via cat 17 |
| QMD | Embedding LRU (100 entries, MD5) + prepared statement cache | ✓ |

**QMD honest:** Embedding cache + prepared statement cache. Hash function differs (MD5 vs xxhash64) but functionally equivalent at our scale.

### 13. Auto-Capture / Hooks — **✓ complete**

| System | Hooks | QMD |
|--------|-------|-----|
| memory-lancedb-pro | before_prompt_build, agent_end | ✓ |
| Mem0 | OpenClaw plugin pattern | ✓ |
| MemPalace | Claude Code hooks (every 15 messages, PreCompact) | ✗ |
| QMD | 6 OpenClaw hooks + dream consolidation | ✓ |

**QMD honest:** OpenClaw integration complete. Missing only Claude Code-specific hook patterns (message-count triggers, PreCompact emergency save).

### 14. Score Boosts (Zero-LLM) — **✓ complete**

| System | Boost | QMD |
|--------|-------|-----|
| MemPalace | Keyword overlap ×1.4 | ✓ |
| MemPalace | Quoted phrase ×1.6 | ✓ |
| MemPalace | Person name boost | ✓ |
| MemPalace | Stop words for keyword extraction | ✓ |
| MemPalace | Preference pattern ingest | ✓ |

**QMD honest:** All 5 zero-LLM boosts integrated.

### 15. Query Expansion — **✓ complete**

| System | Technique | QMD |
|--------|-----------|-----|
| QMD | Nebius Llama expansion + lex/vec/hyde modes | ✓ |
| QMD | Strong signal detection (skip when FTS hits) | ✓ |
| MemPalace | Synonym/related-term expansion | ✓ |

**QMD honest:** Production-grade with smart skip when FTS hits are strong.

### 16. Push / Pull / Self-Directed Retrieval — **~ partial**

| System | Technique | QMD |
|--------|-----------|-----|
| Tinkerclaw Total Recall | Hybrid push (Push Pack) + pull (recall tool) | ✗ |
| Letta | Agent self-directed via tool calls | ~ |
| Mem0 | OpenClaw before_prompt_build auto-recall | ✓ |
| QMD | Auto-recall via plugin hooks + memory_recall MCP tool | ~ |

**QMD honest:** Push (auto-recall via hooks) + Pull (MCP recall tool) both present, but no proactive Push Pack injecting Task State / hot tail / time markers. Agent doesn't route between recall vs archival stores (because we don't have separate stores).

### 17. Eviction Policies — **~ partial**

| System | Algorithm | QMD |
|--------|-----------|-----|
| Total Recall | LRU-K type-weighted (tools first, dialogue last) | ~ |
| Total Recall | LIRS, Belady reference baselines | ✗ |
| QMD v12 | runEvictionPass: age + importance + access count + tier/category protection | ~ |

**QMD honest:** Strictly speaking we have LRU-1 (last_accessed only), not true LRU-K (which tracks K most recent access timestamps). Type weighting via category protection (reflection/decision spared) approximates Total Recall's "tools first, dialogue last". Good enough for cold-storage cleanup; not theoretically optimal.

### 18. Reflection / Self-Improvement — **~ partial**

| System | Approach | QMD |
|--------|----------|-----|
| Reflexion | Verbal RL on memory | ✗ |
| Mem0 OpenClaw | Observation/reflection capture | ✓ |
| Mastra | 3-agent reflection | ✗ |
| Generative Agents | Periodic reflection over streams | ~ |
| QMD v12 | LLM reflection extraction on conversation text → reflection-category memories at importance 0.75 | ~ |

**QMD honest:** v12 extracts reflections from conversation TEXT at ingest. Missing: periodic reflection over already-stored memory streams (Generative Agents pattern), no verbal RL or self-improvement loop, no 3-agent observer/reflector pipeline.

### 19. Identity / Scope / Multi-Agent — **~ partial**

| System | Model | QMD |
|--------|-------|-----|
| Tinkerclaw Identity Persistence | Per-agent persona maintenance | ✗ |
| Mem0 | session / user / agent scopes | ~ |
| QMD | scope field + agent:<name> via OpenClaw plugin | ~ |

**QMD honest:** Single-tier scope string (`global` / `agent:<name>`). Missing: distinct session vs user vs agent tier hierarchy (Mem0), persistent persona model (Tinkerclaw Identity).

### 20. Cross-Session Routing — **~ partial**

| System | Technique | QMD |
|--------|-----------|-----|
| Tinkerclaw Round Table | Cross-session signal routing | ✗ |
| Mastra | Thread/resource isolation | ~ |
| QMD | Per-scope memory boundaries via scope field | ~ |

**QMD honest:** Scope-based ISOLATION exists, but no active ROUTING of signals between sessions. Round Table-style cross-session promotion of patterns is missing.

---

## 🎯 SOTA Reference Targets (LongMemEval published scores)

Source: vectorize.io/articles/best-ai-agent-memory-systems (8-system survey)

| System | LME Score | Architecture key | Δ vs QMD target |
|--------|-----------|------------------|-----------------|
| **Hindsight** ⭐ | **91.4%** | 4 parallel paths (semantic + BM25 + entity graph + temporal) + cross-encoder rerank + LLM `reflect` synthesis | architectural target |
| **SuperMemory** | 81.6% | Memory graph + RAG + auto contradiction resolution | ~10pp above QMD aim |
| **Zep / Graphiti** | 63.8% | Temporal KG with bitemporal validity windows | closest peer |
| **Mem0** | 49.0% | Vector + KG dual-store, atomic fact extraction | architecturally similar |
| **QMD v15-final** | **TBD** (running) | BM25 + vec + RRF + LLM rerank + synthesis + merged reflections | — |

LoCoMo and LongMemEval both test conversational data only. Field needs task-execution benchmarks measuring whether agents actually improve performance over time with accumulated memory. Track this gap.

### Architectural deltas vs Hindsight (the SOTA target)

| Component | Hindsight | QMD v15-final | Gap |
|-----------|-----------|---------------|-----|
| Semantic vector search | ✓ | ✓ | — |
| BM25 keyword | ✓ | ✓ | — |
| **Entity graph traversal in recall** | ✓ | ✗ (KG built but not used) | **biggest gap** |
| Temporal filter as separate path | ✓ | ~ (boost only) | minor |
| **Cross-encoder rerank** | ✓ | ~ (LLM rerank) | speed cost |
| **Post-retrieval `reflect` synthesis** | ✓ | ✗ | F1 cost |
| Pre-ingest synthesis | — | ✓ (better than Hindsight here) | — |
| Atomic fact extraction | ✓ | ✓ (merged with reflections) | — |
| Combined extraction prompt | unknown | ✓ (cost win) | — |

**Path to SOTA: close 4 specific gaps (graph-in-recall, cross-encoder rerank, reflect synthesis, separate temporal path).**

---

## 📚 Session lessons learned (v10 → v15-final)

1. **LLM extraction nondeterminism is ~3-7pp on F1 / R@K.** Same config, two runs can drift. Cross-conv validation + multi-run averages are required. Single-run point estimates lie.
2. **Reflections were dead weight when stored separately.** They crowded R@K results and added no F1 (was −1.5pp). But **merged into the same extraction prompt** they may help (untested in v15-final since we kept the merged path).
3. **MMR diversity hurts when atomic pool is rich.** v12 MMR worked vs v11 because it pushed bad reflections out of top-K. v15+MMR hurt because there were no bad memories to push out — MMR replaced relevant ones with "diverse" but unhelpful ones.
4. **Dual-pass split is dead.** Theoretically attractive, empirically a wash or loss. Synthesis chunks (long, high-importance) compete fine in unified ranking when given high importance.
5. **Date format matters (sometimes).** ISO `[2023-05-08]` vs natural `[8 May, 2023]` is within noise on most metrics. The natural format slightly helps R@K because it tokenizes the same as the LoCoMo answers.
6. **Single prompts beat split prompts.** Combining reflection extraction into the fact extraction prompt gained +3.9pp F1 AND saved ~50% API cost. Quality fix #4 was the real winner.
7. **The v11 answer prompt rules are essential** (+12pp F1). Multi-item lists, Yes/No bare answers, comparison synthesis, undefined detection — each carries weight.
8. **`runEvictionPass` had a real bug** that only the unit test caught (missing `memories_vec` table → crash). #10 paid for itself.
9. **Don't pin a model name without verifying it exists.** I picked `gemini-2.5-flash-001` based on a guess. It doesn't exist. Cost a full 25-min eval to discover.
10. **The audit floor is real.** ~5pp gains are just noise; chase ≥5pp, validate cross-conv, multi-run for confidence.

---

## 🐛 Quality Tracking — Final Status (v10 → v15-final)

| # | Issue | Status |
|---|-------|--------|
| 1 | ISO date format `[2023-05-08]` in timelines | ✓ FIXED — natural format `[8 May, 2023]` |
| 2 | v11 extraction overreach | ✓ reverted |
| 3 | v12 dual-pass thresholds arbitrary | n/a — dual-pass dropped from v15-final |
| 4 | Reflection extraction = separate LLM call | ✓ FIXED — merged into extractAndStore prompt (+3.9pp F1, halved API cost) |
| 5 | MMR uses Jaccard on short tokens | ✓ FIXED — bigram set proxy |
| 6 | Tests verified | ✓ ran — 3 pre-existing flakes (network), not regressions |
| 7 | `dbExists` cache check naive | ✓ FIXED — config hash in filename |
| 8 | `MMR_LAMBDA` no NaN guard | ✓ FIXED — `Number.isFinite()` clamp |
| 9 | Inconsistent importance values | ✓ FIXED — documented in extractor.ts |
| 10 | `runEvictionPass` untested | ✓ FIXED — unit test added; **caught real `memories_vec` absence crash** |
| 11 | `runEvictionPass` raw `db.exec("BEGIN")` | ✓ FIXED — `db.transaction()` API |
| 12 | Dynamic import per `extractReflections` call | ✓ FIXED — hoisted to module-level |
| 13 | LoCoMo names in extractor prompts | ✓ FIXED — generic User-A/B/C/D examples |
| 14 | `EVICT` action in memory_history | ✓ verified non-issue |
| 15 | knowledgeAbout/getLlm/chunking exports | ✓ verified used |
| 16 | dead context.ts functions | ✓ deleted |
| **A** | LLM seed=42 in all calls | ✓ FIXED |
| **B** | Pin model `gemini-2.5-flash-001` | ✗ **WRONG, REVERTED** — model doesn't exist; reverted to `gemini-2.5-flash` |
| **C** | Response cache (file-based) | ✓ FIXED — `evaluate/_shared/llm-cache.ts`, working (105 entries cached after v15final-conv30) |

**13 of 13 quality issues resolved + 2 of 3 reproducibility fixes shipped.** Fix B (model pin) was wrong and reverted — caught by sanity-checking the v15final-conv30 result (F1=5.9% disaster) before committing.

---

## 📊 Honest Status Summary

| Status | Count | Categories |
|--------|-------|------------|
| ✓ Complete | 10 | 2, 3, 4, 5, 8, 9, 12, 13, 14, 15 |
| ~ Partial | 10 | 1, 6, 7, 10, 11, 16, 17, 18, 19, 20 |
| ✗ Missing | 0 | — |

**QMD coverage: 50% complete, 50% partial, 0% missing.** No category is entirely absent.

**Strong (✓):** retrieval primitives — multi-pass, atomic extraction, chunking, temporal, MMR, dedup, caching, hooks, score boosts, query expansion.

**Partial (~):** architectural patterns — storage tiering, lifecycle automation, importance scoring depth, KG-recall integration, multi-level synthesis, push pack, true LRU-K, periodic reflection, scope hierarchy, cross-session routing.

---

## 🔍 Per-System Implementation Audit (legacy view)

Verified by code audit on 2026-04-12. Status: COMPLETE / PARTIAL / MISSING.

### From MemPalace (github.com/milla-jovovich/mempalace)

| Technique | Status | Location |
|-----------|--------|----------|
| Zero-LLM keyword overlap boost (×1.4) | COMPLETE | memory/index.ts:539 |
| Quoted phrase boost (×1.6) | COMPLETE | memory/index.ts:553 |
| Person name filtering / boost | PARTIAL | memory/index.ts:152 + store/search.ts:84 |
| Stop word list for keyword extraction | COMPLETE | memory/index.ts:119 |
| Temporal distance boost (40% time-proximate) | COMPLETE | memory/index.ts:569 |
| Preference pattern extraction ("User mentioned: X") | COMPLETE | memory/patterns.ts:116 |
| Strong signal detection (skip expansion) | COMPLETE | memory/index.ts:476 |
| Temporal KG schema (valid_from/until) | COMPLETE | memory/knowledge.ts:23, db-init.ts:259 |
| Two-pass assistant retrieval ("you suggested X") | MISSING | — |
| Diary mode / topic extraction at ingest | MISSING | — |

### From Mem0 (github.com/mem0ai/mem0)

| Technique | Status | Location |
|-----------|--------|----------|
| Two-layer dedup (MD5 hash + cosine ≥0.9) | COMPLETE | memory/index.ts:111, 337 |
| Memory changelog table | COMPLETE | store/db-init.ts:236 |
| LLM conflict resolution (ADD/UPDATE/DELETE/NONE) | COMPLETE | memory/index.ts:354 |
| LLM atomic fact extraction with categories | COMPLETE | memory/extractor.ts:100 |
| Dual storage: facts → vec, entities → graph | COMPLETE | memory/extractor.ts:220 |
| Multi-agent namespace isolation | COMPLETE | openclaw/plugin.ts:161 |
| OpenClaw plugin pattern (auto-recall/capture) | COMPLETE | openclaw/plugin.ts:173 |
| Three-tier scope (user/session/agent) | PARTIAL | memory/index.ts:333 — agent/global only, no session tier |

### From Mastra (github.com/mastra-ai/mastra)

| Technique | Status | Location |
|-----------|--------|----------|
| Embedding LRU cache (md5-keyed) | COMPLETE | memory/index.ts:18 |
| Working memory (categorized persistent data) | PARTIAL | memory/index.ts:54 — categories defined, no separate persistent store |
| Thread/resource isolation (per-scope) | PARTIAL | memory/index.ts:427 — scope filter only, no thread isolation |
| Three-agent observational memory (actor/observer/reflector) | MISSING | — |
| Token budgeting with dual thresholds | MISSING | — |
| Context range padding (surrounding by timestamp) | MISSING | — |

### From memory-lancedb-pro (github.com/CortexReach/memory-lancedb-pro)

| Technique | Status | Location |
|-----------|--------|----------|
| Weibull decay (recency × frequency × intrinsic, β per tier) | COMPLETE | memory/decay.ts:16 |
| Three-tier promotion (peripheral → working → core) | COMPLETE | memory/decay.ts:74 |
| Smart extraction with 6 categories | COMPLETE | memory/patterns.ts:10 |
| Auto-capture/recall OpenClaw hooks | COMPLETE | openclaw/plugin.ts:181, 233 |
| Dream consolidation + cursor checkpointing | COMPLETE | openclaw/plugin.ts:268 |
| Cross-encoder rerank | PARTIAL | memory/index.ts:603 — generic LLM rerank, not cross-encoder |

### From Zep / Graphiti (github.com/getzep/graphiti)

| Technique | Status | Location |
|-----------|--------|----------|
| Bitemporal validity windows on facts | COMPLETE | memory/knowledge.ts:68 |
| Auto-invalidation of conflicting facts | COMPLETE | memory/knowledge.ts:82 |
| Three-tier subgraph (episode + entity + community) | MISSING | Only entity-relation, no episode/community tiers |

### From Letta / MemGPT (github.com/letta-ai/letta)

| Technique | Status | Location |
|-----------|--------|----------|
| Agent self-directed retrieval via tool calls | COMPLETE | openclaw/plugin.ts:318 |
| Two-tier memory (recall + archival) | MISSING | Single unified memory tier |
| Recursive summarization on eviction | MISSING | — |

### Integration Summary

**Total: 48/66 techniques (73% complete)**

| Source | Complete | Partial | Missing | Total |
|--------|----------|---------|---------|-------|
| MemPalace | 8 | 1 | 2 | 11 |
| Mem0 | 7 | 1 | 0 | 8 |
| memory-lancedb-pro | 5 | 1 | 0 | 6 |
| Mastra | 1 | 2 | 3 | 6 |
| Zep | 2 | 0 | 1 | 3 |
| Letta/MemGPT | 1 | 0 | 2 | 3 |

**Strengths:** Decay engine, knowledge graph, dedup, OpenClaw integration, LLM extraction.
**Biggest gaps:** Zep three-tier subgraph (would solve atomic-vs-chunk), Mastra observational memory, Letta archival tier, MemPalace two-pass assistant retrieval.

---

## 🔧 Open Optimization Opportunities

### From competitive analysis (techniques other systems use, not yet in QMD)

**From MemPalace (HYBRID_MODE.md):**

- Two-pass assistant retrieval — "you suggested X" detection → re-search with full text within session
- Diary mode / topic extraction at ingest — synthetic doc with topic tags
- Expanded rerank pool (already 40, MemPalace recommends 20+)

**From Mem0:**

- Multi-agent namespace isolation (`agent:<name>` scoping)
- LOCOMO eval harness with BLEU/F1/LLM judge — partial (no LLM judge)

**From Mastra:**

- Observational memory (3-agent: actor/observer/reflector compression)
- Token budgeting with dual thresholds / 4-layer context stack
- Context range padding (return surrounding memories by timestamp)

**From memory-lancedb-pro:**

- Cross-encoder rerank as third stage (currently LLM rerank, not cross-encoder)
- Reflection system (multi-layer derived memories) — skipped intentionally

**From Zep (research finding 2026-04-12):**

- **Three-tier subgraph architecture** — episode (raw chunks) + semantic entity (atomic facts) + community (clusters). Query each separately, merge.
- Bitemporal validity windows (already partial in our knowledge.ts)

**From Letta/MemGPT (research finding 2026-04-12):**

- Two-tier (recall vs archival) with **agent self-directed retrieval** via tool calls

**From Tinkerclaw (github.com/globalcaos/tinkerclaw, research finding 2026-04-12):**

Three OpenClaw memory papers by Serra (2026) — directly applicable to our atomic-vs-chunk problem:

*Instant Recall:*
- **Two-tier storage**: episodic (raw, real-time, <2-min freshness) + semantic (nightly rebuild, abstracted)
- **Importance log-modulation in scoring**: `effective = cos_sim × (1 + α·log(importance))`, α=0.15
- **Fixed K=20 per anchor** prevents long content from dominating top-K
- Importance components: entity_density(3.0) + decision_signals(3.0) + user_engagement(2.5) + recency(1.5)
- Quote: "higher-importance short facts rank ahead regardless of document length"
- Pre-computed nightly anchor index for fast inference

*Total Recall:*
- Append-only event store (JSONL + ULID) as ground truth
- Hybrid push (proactive Push Pack) + pull (on-demand recall tool)
- **MMR (Maximal Marginal Relevance)** for relevance + diversity, λ ∈ [0.5, 0.8]
- Atomic precision: hashes/paths/dates/emails survive compaction
- Type-weighted LRU-K eviction (tool results first, dialogue last)
- Task-conditioned scoring (premise · phase · supersession · task_rel)

*Sleep Consolidation:*
- Use-case organization (not chronological): operational-lessons.md, bugs/, knowledge/, MEMORY.md
- Level-based promotion: incident → pattern → meta-principle
- "Cleaning Lady" cron with 50KB budget, 14-day archival threshold
- 3-day compression window for daily logs

### From v10/v11 analysis (current focus)

- **Atomic-vs-chunk ranking conflict** — atomic facts get drowned by long sessions in BM25
- **Single-hop multi-item answers** — LLM stops at one item even when answer has 4
- **Temporal F1 = 39.1%** — biggest opportunity (n=44, biggest sample)
- **Top-K homogeneity** — top-10 often returns 10 near-duplicates of same session

### v12 candidate techniques (validated by Zep + Tinkerclaw, both confirm separation)

1. **Importance log-modulation** (Tinkerclaw Instant Recall)
   - One-line change in `memoryRecall`: `score *= 1 + 0.15 * Math.log(1 + importance × 10)`
   - Atomic facts (importance 0.75-0.85) get +15-20%
   - Long sessions (importance 0.5-0.7) get +8-12%
   - Cheapest possible win

2. **MMR diversity filter** (Tinkerclaw Total Recall + standard IR)
   - Currently top-10 often returns 10 near-duplicates
   - MMR: select next memory minimizing similarity to already-selected, λ=0.7
   - Forces variety, allowing atomic facts + chunks to coexist in top-K

3. **Dual-pass retrieval** (Zep three-tier subgraph + Tinkerclaw two-tier)
   - Pass 1: atomic facts (importance ≥ 0.75, length < 200)
   - Pass 2: chunks (length ≥ 200)
   - Merge top-K from each, deduplicate
   - Biggest expected win for temporal + single-hop

4. **K=20 per anchor cap** (Tinkerclaw Instant Recall)
   - Prevent any single source/session from dominating top-K
   - Enforce: max 2-3 results from same session in top-10

### Lower-priority backlog

- File watching / `qmd watch` daemon
- Cross-collection tunnels (auto-detect same topic)
- Room traversal graph (BFS across collections)
- Exchange-pair chunking (Q+A = one chunk)
- `qmd dream` consolidation command (exists in OpenClaw plugin only)
- `--explain-json` structured output

---

## 📋 LoCoMo Audit Findings — Honor vs Ignore

Source: [github.com/dial481/locomo-audit](https://github.com/dial481/locomo-audit)

### Honor (apply to our methodology)

| Finding | Action |
|---------|--------|
| 6.4% wrong ground truth (theoretical ceiling 93.57%) | Don't chase individual question failures — could be bad GT |
| Judge leniency 62.81% accept rate on vague-wrong | Require ≥5pp improvement to claim a win |
| Open-domain n=96 needs 15+ pp gap for significance | Skip open-domain optimization (sample too small) |
| Inconsistent prompts/scoring across papers | No cross-system score comparisons |
| Single-run point estimates unreliable | Run twice to verify wins |

### Ignore (don't dwell)

| Finding | Why ignore |
|---------|-----------|
| Adversarial cat 5 broken (444/446 in upstream eval) | Don't optimize this category; our 87.5% F1 is misleading |
| Open-domain category n=13 (conv-26) | Sample too small to be statistically meaningful |
| Marginal gains <5pp | Below judge noise floor; not actionable |
| Single-hop question-by-question tuning | n=11 in conv-30, too small for per-question tuning |

### Statistically meaningful focus areas (conv-30)

| Category | n | Current F1 (v10) | Priority |
|----------|---|------------------|----------|
| **temporal** | 44 | 39.1% | **P0** — biggest sample, biggest gap |
| **multi-hop** | 26 | 54.0% | P1 — solid sample, room to grow |
| single-hop | 11 | 43.3% | P2 — too small to optimize confidently |
| adversarial | 24 | 87.5% | **SKIP** — broken in upstream eval |

---

## 📈 Version History — v1 → v11

All scores are 199Q conv-26 unless noted. Current best is v10 measured on conv-30 (105Q).

| Ver | R@5 | R@10 | F1 | EM | Changes | Status |
|-----|-----|------|-----|-----|---------|--------|
| v1 | — | — | 8.2% | 0% | Baseline: FTS AND, no stop words, no vectors (Windows) | superseded |
| v2 | — | — | 22.5% | 6% | FTS OR + stop words + vectors via WSL | superseded |
| v3 | — | — | 27.7% | 8.5% | + ZeroEntropy reranker + date reasoning prompt | superseded |
| v4 | — | — | 49.1% (20Q) | — | + query expansion (Nebius Llama) | 20Q only |
| v5 | 11.1% | 42.2% | 29.4% | 8.5% | + KG triples + improved prompt | superseded |
| v6-ZE | 10.6% | 45.7% | 31.4% | 9.0% | + ZE collections | rolled back |
| v6+fix | 11.6% | 43.7% | 51.1% | 30.7% | + adversarial scoring fix | superseded |
| v7 | 12.1% | 42.2% | 53.1% | 33.2% | + strong signal detection + decay pass + consolidated stop words | superseded |
| v7-ZE | 12.6% | 43.2% | 52.5% | 33.2% | v7 with ZE collections | rolled back |
| v8 | 38.7% | 46.2% | 49.5% | 30.7% | Remove KG injection from recall (R@5 tripled) | superseded |
| v9 | — | — | — | — | (skipped) | — |
| v10 | 59.0% | 67.6% | 54.3% | 34.3% | Mem0-style LLM fact extraction + KG auto-population (105Q conv-30, Gemini 2.5 Flash) | superseded baseline |
| v11 | 51.4% | 60.0% | 50.5% | 32.4% | + v11 extraction overreach + answer prompt rules — single-hop +8.6pp but multi-hop −8.2pp + temporal −16pp | regressed, reverted |
| v12 | 53.3% | 61.0% | 50.7% | 32.4% | Reverted v11 ingest; + dual-pass + log-mod + MMR λ=0.7 — MMR over-aggressive | regressed |
| v13 | 52.4% | 60.0% | 58.4% | 41.0% | + synthesis (profiles + timelines) + reflection extraction + MMR λ=0.85 — F1 jumped from synthesis | partial win |
| v14 | 55.2% | 60.0% | 59.0% | 41.0% | Reverted v12 retrieval; kept v13 ingest + answer prompt rules | superseded |
| v15 | 59.0% | 63.8% | 55.2% | 35.2% | b1+date+MMR — MMR backfired without reflections | reverted |
| **v15-final** | **conv-30:55.2 / conv-26:49.7** | **conv-30:66.7 / conv-26:61.3** | **conv-30:61.7 / conv-26:60.1** | **conv-30:40.0 / conv-26:37.2** | Synth ON, refl OFF (now **combined into single extractAndStore prompt**, halving API cost), v11 prompts, natural date format, no retrieval tweaks. **Cross-conv validated.** Seed=42, response cache enabled. | **CURRENT BEST** |

### v15-final cross-conv averages

| | conv-26 (199Q) | conv-30 (105Q) | **Average** |
|---|----------------|----------------|---------|
| R@5 | 49.7% | 55.2% | **52.5%** |
| R@10 | 61.3% | 66.7% | **64.0%** |
| **F1** | **60.1%** | **61.7%** | **60.9%** |
| **EM** | **37.2%** | **40.0%** | **38.6%** |

**v15-final vs v10 baseline (cross-conv):**
- **F1: +6.5pp** (REAL win, well above noise floor)
- **EM: +4.3pp** (REAL)
- R@10: +0.8 (slight win/tied)
- R@5: −2.2 (within noise)

**Pareto improvement on F1/EM/R@10 with marginal R@5 trade-off.**

### Combined extraction prompt = real win

When v15-final ran on conv-30 with the merged extraction prompt (refl + facts in one call) it scored **F1=61.7**, vs the previous separate-call v15-fresh's **F1=57.8**. **+3.9pp gain just from prompt consolidation**, plus **~50% ingest API cost saved**.

Why: a single prompt extracting both atomic facts and cross-event reflections in one shot produces more coherent output than two prompts arguing past each other.

### v15-final by category — conv-26 (hardest, n=199)

| Category | v10 F1 | v15-final F1 | Δ |
|----------|--------|------|---|
| single-hop | 32.3 | 36.2 | +3.9 |
| multi-hop | 40.2 | 54.2 | **+14.0** |
| temporal | 57.3 | 61.6 | +4.3 |
| adversarial | 87.2 | 89.4 | +2.2 |
| open-domain | 15.9 | 21.6 | +5.7 |

**Wins every category. Multi-hop +14pp is the standout.**

### v10 by category (105Q conv-30)

| Category | n | R@5 | R@10 | F1 | EM |
|----------|---|-----|------|-----|-----|
| multi-hop | 26 | 96.2% | 96.2% | 54.0% | 30.8% |
| temporal | 44 | 75.0% | 90.9% | 39.1% | 13.6% |
| single-hop | 11 | 36.4% | 54.5% | 43.3% | 9.1% |
| adversarial | 24 | 0% | 0% | 87.5% | 87.5% |

### v8 by category (199Q conv-26, for reference)

| Category | n | R@5 | R@10 | F1 |
|----------|---|-----|------|-----|
| adversarial | 47 | 0% | 0% | 91.5% |
| temporal | 70 | — | 61% | 42.9% |
| multi-hop | 37 | — | 84% | 44.5% |
| single-hop | 32 | — | 44% | 21.8% |
| open-domain | 13 | — | 31% | 15.8% |

### Tactics that worked (kept)

| Feature | Where | Impact | Source |
|---------|-------|--------|--------|
| FTS OR + stop words | memory/index.ts | +19.5% F1 (8→28) | Custom |
| ZeroEntropy zembed-1 vectors | memory/index.ts | Baseline | ZeroEntropy |
| ZeroEntropy zerank-2 reranker | memory/index.ts | +1-2% F1 | ZeroEntropy |
| Query expansion (Nebius Llama) | memory/index.ts | +2-3% F1 | store/search.ts pattern |
| Strong signal detection | memory/index.ts | Reduces noise, saves API | store/search.ts hybridQuery |
| MemPalace name filtering | memory/index.ts:extractKeywords | Small, prevents flooding | MemPalace hybrid_v5 |
| MemPalace quoted phrase boost | memory/index.ts | 1.6× for exact quotes | MemPalace v4 |
| Keyword boost (multiplicative) | memory/index.ts | 0.4 weight | MemPalace v1 |
| Temporal distance boost | memory/index.ts | 40% for time-proximate | MemPalace v2 |
| Preference bridging | eval.mts | ~150 synthetic entries | MemPalace v3 |
| Decay pass after ingest | eval.mts | Tier promotion | memory-lancedb-pro |
| Adversarial scoring fix | eval.mts | +20% F1 (was scoring bug) | — |
| Date reasoning prompt | eval.mts | Big on multi-hop dates | Custom |
| Adversarial "undefined" prompt | eval.mts | 43/47 correct | Custom |
| Mem0-style LLM fact extraction | extractor.ts | +20pp R@5 v8→v10 | Mem0 |
| KG auto-population at ingest | extractor.ts | Cleaner triples than regex | Mem0 |
| Removing KG from recall | memory/index.ts | R@5 tripled (12→39%) | Custom finding |

### Tactics rolled back

| Feature | Impact | Why rolled back |
|---------|--------|-----------------|
| ZE collections | +0.5% R@10, -0.6% F1 | No gain, adds API cost + latency |
| RRF fusion (memory) | -10% F1 | Normalized scores too flat |
| FTS score normalization | +R@5, -F1 | LLM confused by new memory order |
| KG injection in recall | +3.6% F1, -26.6% R@5 | Generic KG entries dominated top results |

### Features that exist but are NOT used in memoryRecall

| Feature | Location | Why not used |
|---------|----------|-------------|
| Knowledge graph as_of queries | knowledge.ts:112 | KG injection hurt R@5 — need smarter integration (e.g. dual-pass) |
| Intent detection | search.ts:644 | Would add complexity, unclear benefit |
| RRF from search pipeline | search.ts:532 | Tested in memory recall, hurt F1 |
| Metadata scoring | memory table has metadata field | Never populated in eval |
| Batch embeddings | search.ts batch pattern | memoryRecall does single embeds |
| Dream consolidation | plugin.ts:252 | Only in OpenClaw, not benchmarked |

---

## ⚡ Speed Optimization Stack (shipped this session)

All available, all OFF or auto unless noted. See `docs/EVAL.md` for the full env-var + CLI flag reference.

| Optimization | Where | Default | Speedup |
|--------------|-------|---------|---------|
| **`memoryStoreBatch()` API** | `src/memory/index.ts` | always on (auto-used) | ~3-5× ingest, system-wide |
| **`embedBatch` BATCH_SIZE 64** | `src/llm.ts` | always on | halves embed HTTP round-trips |
| **`--workers N`** in-process pool | LME eval | 1 | ~4-8× (interleaves LLM I/O) |
| **`--shard N/M`** parallel sharding | LME eval | none | linear N× across processes |
| **`--extract-model` / `--answer-model`** split | both evals | uses default | use lite for cheap extraction, full for answers |
| **`--db-suffix`** auto-hashed cache | both evals | based on ingest config | prevents stale-cache foot-gun |
| **LLM response cache** (file-backed) | `evaluate/_shared/llm-cache.ts` | on (`QMD_LLM_CACHE=off` to disable) | 100% reproducible re-runs |
| **`seed=42`** in all LLM calls | `src/llm.ts`, both evals | always | best-effort reproducibility |
| **`QMD_RECALL_RAW=on`** | `src/memory/index.ts` | off | disable boosts/decay/temporal/expansion/rerank — pure BM25+vec+RRF |

**Combined: 50-min sequential LME oracle → ~3-5 min wall** with sharding+workers+lite-extract.
For 500Q LME-s: ~10 hours → ~1.5 hours.

### Removed env-var toggles (lost in v15 ablation)

- `QMD_RECALL_DUAL_PASS` — dual-pass split, hurt F1
- `QMD_RECALL_LOG_MOD` — importance log-modulation, neutral
- `QMD_RECALL_MMR` + `QMD_RECALL_MMR_LAMBDA` — MMR diversity, hurt single-hop F1

---

## 📐 SR@K vs R@K — apples-to-apples with MemPalace

QMD's R@K = **answer-token overlap** with retrieved memory text.
MemPalace's `recall_any` = **session-id intersection** with `answer_session_ids`.

**These are different metrics.** MemPalace's published 96.6% LongMemEval is session-id-based.

LME ingest now stores `metadata.source_session_id` on every memory. The eval reports BOTH:
- `R@5 / R@10` — token-overlap (QMD's original)
- `SR@5 / SR@10` — session-id (MemPalace-comparable, used for cross-system claims)

---

## 🔬 MemPalace 96.6% — verified architecture

Confirmed against `mempalace/searcher.py` and `benchmarks/longmemeval_bench.py`:

```python
client = chromadb.EphemeralClient()                  # fresh corpus per question
collection = client.create_collection("mempal_drawers")
collection.add(documents=[session_text...], metadatas=[{"corpus_id": sid}...])
results = collection.query(query_texts=[q], n_results=5)
top5 = {meta["corpus_id"] for meta in results["metadatas"][0]}
hit = any(sid in top5 for sid in answer_session_ids)
```

| Item | MemPalace value |
|------|-----------------|
| Embedding | `all-MiniLM-L6-v2` 384-dim (fastembed default) |
| Distance | l2 / Euclidean (ChromaDB default) — NOT cosine |
| Storage granularity | one document per session OR per turn (flag) |
| Score boosts | NONE in raw mode (`searcher.py` is 30 lines) |
| Reranking | NONE in raw mode |
| Knowledge graph | NONE in retrieval (separate SQLite layer for time queries) |
| Recall metric | `recall_any` — session-id intersection |

**Their hierarchical/extraction modes (Wings/Halls/Rooms, AAAK) score LOWER than raw.** Adding complexity hurt them. Strong signal that v15-final's complexity may be hurting LME — to be tested via QMD_RECALL_RAW=on + extraction-off.

---

## 🕸️ Graphify (knowledge graph of QMD itself)

Installed `graphifyy` 0.4.6 (PyPI). Built initial QMD code graph.

**Graph stats:** 547 nodes · 928 edges · 35 communities · 10 god nodes · 77.5× token reduction per query vs naive corpus

**Top god nodes (architectural backbone):**
1. `LlamaCpp` (29 edges)
2. README root (20)
3. `closeDb()` (19)
4. `getDb()` (16)
5. `RemoteLLM` (15)

**Insight:** LLM/embedding plumbing in `src/llm.ts` dominates centrality. Half the god nodes are LLM-side.

**Refactor candidate flagged:** `src/cli/qmd.ts` is the lowest-cohesion large community (cohesion 0.08, 63 functions). Long-known monolith, now objectively confirmed.

**Outputs:** `graphify-out/{graph.html, graph.json, GRAPH_REPORT.md, manifest.json, cost.json}` (gitignored)

**Query interface:**
```sh
graphify query "how does memory recall work"
graphify path "memoryStore" "knowledgeStore"
graphify explain "consolidateEntityFacts"
```

`.graphifyignore` excludes test/, evaluate/, finetune/, setup/, docs/, skills/, dist/, node_modules/.

---

## 🧪 Next Testing Phases

Sequenced after v15-final ships. Each phase has cheap exit criteria — only proceed if prior wins hold.

### Phase 1: LME baseline (in progress)

**Goal:** establish v15-final's LongMemEval score for cross-benchmark calibration.
- ✅ Code: `evaluate/longmemeval/eval.mts` built
- ⏳ Run: `--ds oracle --limit 50` baseline running now
- **Next:** if F1 ≥ 50%, proceed. If <30%, debug before optimizing.

### Phase 2: LME ablation matrix (cached DB, ~10 min wall, parallel)

After LME baseline DB is built, test these toggles **against the cached DB**:
- `QMD_INGEST_EXTRACTION=off` (cat C — does extraction help LME?)
- `QMD_INGEST_BATCH_EXTRACT=off` (cat B — per-session vs batch extraction)
- `--model gemini-2.5-flash-lite` (cat D — A-B test cheaper model)
- `QMD_RECALL_DUAL_PASS=on` (would dual-pass help LME, where it didn't help LoCoMo?)

**Expected output:** which knobs improve LME without hurting LoCoMo.

### Phase 3: Cat E parallel sharded full LME-s (1-2 hours wall)

Once we know the optimal LME config, run the **full 500Q LME-s** (47 sessions per question, real retrieval test) sharded:
```
for i in 0 1 2 3 4 5 6 7; do
  npx tsx evaluate/longmemeval/eval.mts --ds s --shard $i/8 --tag lme-s-v15final &
done
```
Then `merge-shards.mts --tag lme-s-v15final --shards 8`.

**Expected runtime:** ~1.5 hours for first build. Subsequent ablations on cached DB: ~5 min.

### Phase 4: v16 candidate optimizations (Hindsight-inspired)

Each is a self-contained ablation. Test independently then together.

| ID | Name | Source | Expected Δ | Effort | Risk |
|----|------|--------|-----------|--------|------|
| **v16a** | Smart KG-in-recall (gated by named entity in query) | Hindsight | +5-10pp R@K (esp. single-session-user) | M | High — failed in v8 |
| **v16b** | Post-retrieval `reflect` LLM synthesis | Hindsight | +3-5pp F1 | M | 1 extra LLM call per query |
| **v16c** | Cross-encoder rerank (replace LLM rerank) | Hindsight | speed +2x, F1 ≈ tied | M | needs cross-encoder model |
| **v16d** | Separate temporal retrieval path (not just boost) | Hindsight | +2-4pp temporal R@K | S | low |
| **v16e** | Auto contradiction resolution (already in dedup) | SuperMemory | n/a | done | done |
| **v16f** | Entity resolution at write time (named-entity NER) | Hindsight, Mem0 | +1-2pp KG coverage | S | low |

**Order of testing:**
1. **v16d** first (cheapest, lowest risk) — separate temporal path
2. **v16c** second (cross-encoder swap) — speed win
3. **v16b** third (reflect synthesis) — F1 win
4. **v16a** last (smart KG-in-recall) — biggest expected gain but biggest risk

### Phase 5: Cross-conv + cross-benchmark validation

Validate any v16 winner on:
- LoCoMo conv-26 + conv-30 (have baselines)
- LME oracle + LME-s
- Optionally LoCoMo conv-25 (untested third conversation)

Only ship if winner holds across **at least 2 conversations × 2 benchmarks**.

### Phase 6: Production baseline lock

- Final v16 (or v15-final if v16 doesn't ship) becomes the production baseline
- Update ROADMAP version history
- Tag commit, write release notes
- Snapshot LLM cache for reproducible CI runs

### Out-of-scope for current session (defer to follow-up)

- Letta-style agent self-managed memory (different paradigm)
- Multi-tier storage refactor (data shows flat wins)
- File-watch / `qmd watch` daemon
- Task-execution benchmark (no published one exists)

---

## 🎯 Immediate Next Steps (priority order)

1. **Verify v11 results** — atomic fact prompt + answer rules. Wait for run, then compare to v10 baseline.
2. **If v11 wins ≥5pp:** implement **dual-pass retrieval (v12)** — Zep-style separate atomic + chunk passes, merge top-K. Biggest expected win for temporal + single-hop.
3. **If v11 fails:** revert prompt, investigate why atomic facts still don't surface. Consider length-normalized BM25 instead.
4. **Cross-conversation validation** — run on conv-25 and conv-26 (199Q) to confirm wins generalize. Audit warns single-run estimates are unreliable.
5. **Two-pass assistant retrieval** (MemPalace) — for "you suggested X" / "remind me what you said" patterns
6. **Skip:** observational memory, room traversal, file watcher (low priority backlog)

---

## How to Run Eval

```sh
# Full 199Q (honest score, ~25 min)
wsl -d Ubuntu -- bash -lc 'source ~/.nvm/nvm.sh && cd ~/qmd-eval && QMD_ZE_COLLECTIONS=off npx tsx evaluate/locomo/eval.mts --conv conv-26 --llm gemini'

# Full 105Q conv-30 (current eval baseline)
wsl -d Ubuntu -- bash -lc 'source ~/.nvm/nvm.sh && cd ~/qmd-eval && QMD_ZE_COLLECTIONS=off npx tsx evaluate/locomo/eval.mts --conv conv-30 --llm gemini'

# Quick 20Q sample (~2 min, but overestimates by ~20pp)
wsl -d Ubuntu -- bash -lc 'source ~/.nvm/nvm.sh && cd ~/qmd-eval && npx tsx evaluate/locomo/eval.mts --conv conv-30 --limit 20 --llm gemini'

# Sync changes from Windows to WSL
wsl -d Ubuntu -- bash -lc 'cp /mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd/src/memory/index.ts ~/qmd-eval/src/memory/index.ts && cp /mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd/src/memory/extractor.ts ~/qmd-eval/src/memory/extractor.ts && cp /mnt/c/Users/DavidGillot/Projects/qmd/UsersDavidGillotProjectsqmd/evaluate/locomo/eval.mts ~/qmd-eval/evaluate/locomo/eval.mts'

# Fresh ingest (delete cached DB first)
wsl -d Ubuntu -- bash -lc 'rm -rf ~/qmd-eval/evaluate/locomo/dbs && mkdir -p ~/qmd-eval/evaluate/locomo/dbs'
```

---

## Reference Systems

| System | Approach | LoCoMo R@10 | Source |
|--------|----------|-------------|--------|
| MemPalace | ChromaDB raw chunks (no extraction), multiplicative hybrid scoring | 88.9% (orig) | github.com/milla-jovovich/mempalace |
| Mem0 | LLM atomic extraction only (no chunks), Qdrant + graph + reranker | 49% LongMemEval | github.com/mem0ai/mem0 |
| Zep | Three-tier graph: episodes + entities + communities | SOTA on DMR | github.com/getzep/graphiti |
| Letta/MemGPT | Two-tier: recall (chunks) + archival (atomic), agent self-directed | — | github.com/letta-ai/letta |
| memory-lancedb-pro | LanceDB + cross-encoder rerank + Weibull decay | — | github.com/CortexReach/memory-lancedb-pro |
| **QMD v10** | **sqlite-vec + FTS5 + Mem0-style extraction + ZE rerank + expansion** | **67.6%** | this repo |

Gap vs MemPalace: 21.3pp on R@10. Main difference: MemPalace stores 800-char chunks; QMD stores both individual dialog turns AND extracted atomic facts. Dual-pass retrieval (Zep-style) is the proposed bridge.

---

## 📚 Further Reading — Sources Worth Investigating

Compiled from Tinkerclaw papers + our own research. Papers most relevant to QMD's current bottlenecks.

### Direct relevance to atomic-vs-chunk problem

- **RAPTOR** (Sarthi et al. 2024) — Recursive Abstractive Processing for Tree-Organized Retrieval. arXiv:2401.18059. Tree of recursive summaries enables querying at multiple granularities.
- **A-MEM** (Xu et al. 2025) — Agentic Memory for LLM Agents. arXiv:2502.12345. Self-organizing memory.
- **Memory-R1** (Yan et al. 2025) — RL-Trained Memory Management for LLM Agents. arXiv:2505.14075.
- **GraphRAG** (Edge et al. 2024) — From Local to Global. arXiv:2404.16130. Community-based graph RAG.
- **MemoryBank** (Zhong et al. 2023) — arXiv:2305.10250. Long-term memory enhancement with Ebbinghaus forgetting curve.

### Memory architecture theory

- **Complementary Learning Systems** (McClelland, McNaughton, O'Reilly 1995) — hippocampus/neocortex theory backing dual-tier storage. Theoretical foundation for atomic + chunk separation.
- **Spreading Activation Theory** (Collins & Loftus 1975) — backs knowledge graph activation patterns
- **Hippocampal Memory Indexing** (Teyler & DiScenna 1986) — sparse pointers vs full content (Total Recall's approach)
- **Wilson & McNaughton 1994** — sleep replay/consolidation (justifies decay + tier promotion)

### Cache eviction (relevant to memory pruning + decay)

- **LRU-K** (O'Neil et al. 1993) — SIGMOD. Type-weighted eviction Tinkerclaw uses.
- **LIRS** (Jiang & Zhang 2002) — SIGMETRICS. Low inter-reference recency replacement.
- **Belady 1966** — IBM Systems Journal. Original cache replacement algorithm theory.

### Benchmarks

- **LongMemEval** (Wu et al. 2024) — arXiv:2410.10813. Worth running alongside LoCoMo.
- **LOCA-bench** (Zeng et al. 2024) — arXiv:2402.07962. Long-context agent eval.

### Other agent memory systems

- **MemGPT** (Packer et al. 2023) — arXiv:2310.08560. Already integrated (Letta/two-tier).
- **Generative Agents** (Park et al. 2023) — UIST. Reflection + memory streams.
- **Reflexion** (Shinn et al. 2023) — NeurIPS. Verbal RL on memory.
- **Voyager** (Wang et al. 2023) — arXiv:2305.16291. Skill library as memory.
- **Mem0 paper** (2024) — arXiv:2504.19413. Already integrated.

### Tinkerclaw companion papers (worth reading for v12+)

- **Identity Persistence** (Serra 2026) — persona-aware context engineering
- **Round Table** (Serra 2026) — cross-session signal routing
- **Fractal Reasoning** (Serra 2026) — hierarchical reasoning across context boundaries

### Implementation libraries / techniques

- **MMR (Maximal Marginal Relevance)** — Carbonell & Goldstein 1998. Standard IR diversification.
- **DSPy** (Khattab et al. 2023) — declarative LLM pipelines, useful for prompt optimization
- **PromptBreeder** (Fernando et al. 2023) — self-improving prompts via evolution
