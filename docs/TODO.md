# QMD TODO — Optimization Backlog

> Consolidated from `docs/ROADMAP.md` (categories 1-20, competitive audit, open
> optimization opportunities) + night 2026-04-13→14 A/B discoveries +
> 2026-04-14 code audit against the as-shipped src/.
> Last updated: 2026-04-14.
>
> **Reading order:** scan §0 for "shipped but untested in eval" — these have
> the highest leverage tonight. §1 for near-term moves. §2 for feature parity
> with reference systems. §3 for infrastructure/tooling. §4 for parked ideas.

---

## §0 — Already shipped but never wired into the eval baseline

These are features that exist in `src/memory/index.ts` (or adjacent) but
default-off, untested at n=500, and could move multi-session if turned on.
**Highest leverage in the night plan** because the code work is already done
— only an env-var flip and one A/B run away.

| Feature | Flag | Location | Status |
|---|---|---|---|
| **Smart KG-in-recall** | `QMD_RECALL_KG=on` | `index.ts:1169` | Shipped v16 with three-condition gating. Untested at n=500 vs the 82% multi ceiling. |
| **Hindsight reflect synthesis** | `memoryReflect()` API | `index.ts:1255` | Post-retrieval LLM pass. Not wired into eval harness. |
| **Periodic reflection pass** | `runReflectionPass()` API | `index.ts:1306` | Generative-Agents-style background reflection. Not wired. |
| **Push Pack** | `pushPack()` API | `index.ts:1400` | Tinkerclaw Total Recall pattern: Task State + core + hot-tail + time markers. Not wired. |
| **Tier-grouped recall** | `runTieredRecall()` API + `tier` filter on `memoryRecall` | `index.ts:1488` | Three-tier (peripheral/working/core) decay-backed promotion exists. Tier filtering at retrieval time exists. Untested as a multi-session lever. |
| **Per-turn ingest** | `QMD_INGEST_PER_TURN=on` (eval only — opposite of usual) | `evaluate/longmemeval/eval.mts:384` | All baselines turn it OFF for benchmark fairness. Turning it ON converts 50 memories/scope into ~500 — finer-grained, untested. |
| **LRU-K-flavored eviction** | `runEvictionPass()` | `decay.ts:135` | Single-field backward window approximation; honest about not being true LRU-K. |
| **Memory dialog diversity** | `QMD_RECALL_DIVERSIFY=on` (non-RAW) or `QMD_MEMORY_MMR=session` (RAW-compat, new tonight) | `index.ts:1213` | RAW-compat gate added 2026-04-14. Phase 4 in flight to confirm signal at n=500. |

**Action: queue a "phase 5 wiring sweep" — one n=500 run per shipped flag, see what moves the multi-session needle.** That's effectively free experimentation against existing code. Highest expected ROI in the night plan.

---

## §1 — Multi-session ceiling attack (active v17 goal)

The 82% R@5 multi-session ceiling on LME _s n=500 is the headline bottleneck.
All items in this section target that metric.

### Confirmed lifts shipped 2026-04-14

- [x] **arctic-s q8 embed model** — `QMD_TRANSFORMERS_MODEL=Snowflake/snowflake-arctic-embed-s` → **+2.2pp** multi-session (82% → 84.2%), −1pp overall R@5. First model to break 83% ceiling on LME.
- [x] **Zero-LLM keyword-group expansion** — `QMD_MEMORY_EXPAND=keywords` → **+1pp** multi-session on mxbai-xs q8 (82% → 83%). Fans out 1 base + 2 keyword-cluster sub-queries.
- [x] **Loose cosine floor escape hatch** — `QMD_VEC_MIN_SIM=0.1` → +0.8pp R@10 (not R@5). Lets more candidates survive the adaptive gate on tight-distribution q8 models.
- [x] **RAW-compatible dialog diversity** — `QMD_MEMORY_MMR=session` fires `applyDialogDiversity` even in RAW eval mode. Null signal at n=100 (top-5 already diverse enough for mxbai); awaiting phase-4 n=500 fix confirmation.

### Next measurements (phase 4 — in flight)

- [ ] arctic-s q8 × `QMD_MEMORY_EXPAND=keywords` n=500 — targets ≥85% multi-session (stacked +2.2pp model + +1pp expand).
- [ ] arctic-s q8 × loose-floor × expand × fixed-MMR n=500 — full-stack test.
- [ ] mxbai-xs q8 × loose × expand × fixed-MMR n=500 — isolates the MMR fix signal on the current production default.

### Queued experiments (v17)

- [ ] **Cross-encoder rerank via `transformers.js`** — `mixedbread-ai/mxbai-rerank-base-v1` ONNX, ~80 lines mirroring `TransformersEmbedBackend`. Biggest expected lift if embed+expand plateau. Blocks: none. Priority: **highest**.
- [ ] **Per-turn ingest A/B on LME** — flip `QMD_INGEST_PER_TURN=on`, rebuild dbs, rerun n=500. Turns ~50 memories/scope into ~500, increasing granularity. Untested, cheap, possibly unlocks sub-session retrieval. Priority: **highest**.
- [ ] **Model-aware floor calibration** — `QMD_VEC_FLOOR_RATIO=<0-1>` env knob to replace the hardcoded `relRatio=0.5` in `pickVectorMatches`. Auto-calibrate per-model based on observed top-1 distribution at sanity-probe time. mxbai-xs q8 wants ~0.3, MiniLM fp32 wants 0.5.
- [ ] **arctic-xs int8/uint8/q4 at n=500** — only q8 tested at n=500. Quantization broke the 83% ceiling for MiniLM uint8; may do the same for arctic-xs. Cheap (~15m each).
- [ ] **arctic-m q8 revisit with loose floor** — arctic-m q8 was strictly worse at n=100 (mem=28 vs 48) because the adaptive floor over-filtered on 768d. Worth one n=500 pass with `QMD_VEC_MIN_SIM=0.1` to see if 768d has latent signal.
- [ ] **arctic-s dtype sweep (int8/uint8)** — current winner is q8 only. Same quant logic as MiniLM precedent.

---

## §2 — Technique parity with reference systems

Items that other memory systems ship and QMD doesn't. Sorted by expected signal
on LME-class workloads.

### Category 2 — Multi-pass / hybrid retrieval

- [ ] **Cross-encoder rerank** (memory-lancedb-pro, Hindsight) — ranked #1 lever. See §1.
- [x] ~~Entity graph traversal in recall with smart gating~~ — **already shipped v16** as `QMD_RECALL_KG=on` (`src/memory/index.ts:1169`). Three-condition gating (opt-in, ≥1 proper-noun entity, top score < 0.3) avoids the v8 blunt-injection failure mode. Untested at n=500 against multi-session — could be worth turning on in a phase 5 A/B.
- [ ] **4-parallel-path retrieval** (Hindsight) — semantic + BM25 + entity graph + temporal filter + cross-encoder rerank. Currently 2 paths (BM25 + vector). The KG path exists but is gated; cross-encoder is the missing fourth. Still the biggest identified gap vs SOTA.

### Category 11 — Synthesis / post-retrieval

- [x] ~~Hindsight-style `reflect` pass~~ — **already shipped** as `memoryReflect()` (`src/memory/index.ts:1255`). Takes question + top-K, makes 1 LLM call, returns synthesized answer context. Not wired into the eval harness, untested as a multi-session lever.
- [ ] **RAPTOR pre-ingest recursive abstractive tree** — tree of progressive summaries. Heavy ingest cost, unclear retrieval win.
- [ ] **Mastra 3-agent pre-ingest compression** (actor/observer/reflector).
- [x] ~~Periodic reflection over stored memory streams~~ (Generative Agents pattern) — **already shipped** as `runReflectionPass()` (`src/memory/index.ts:1306`). Pulls last N memories, derives reflections via LLM, stores as new memories. Cron-callable. Untested in eval baselines.

### Category 4 — Chunking strategy

- [~] **Per-turn ingest A/B** — code support shipped (`QMD_INGEST_PER_TURN`, gates `evaluate/longmemeval/eval.mts:384`). All baselines turn it OFF. Running it ON at n=500 is still untested — see §1.
- [ ] **800-char chunk experiment** (MemPalace sizing baseline).
- [ ] **Exchange-pair chunking** (Q+A = one chunk). Untested.
- [ ] **Context range padding** (Mastra) — return surrounding memories by timestamp window, not just top-K by score.

### Category 1 — Tiered / hierarchical storage

- [x] ~~Tier-grouped retrieval~~ — **already shipped** as `runTieredRecall()` (`src/memory/index.ts:1488`) + `tier` filter on `memoryRecall()`. Three tiers (peripheral/working/core) backed by `decay.ts` promotion. NOT a full storage-level separation though — all memories live in one table, the tiers are scoring-time labels.
- [ ] **Two-tier recall + archival** (Letta/MemGPT) — separate STORES with agent self-directed routing. Storage-level separation, not just label-level. Major architecture change.
- [ ] **Three-tier subgraph** (Zep) — episode (raw) + semantic entity (atomic facts) + community (clusters). Query each separately, merge. Biggest architectural gap vs Zep/Graphiti.
- [ ] **Sleep consolidation use-case folders** (Tinkerclaw) — lessons/bugs/knowledge organization, not chronological.
- [ ] **Level-based promotion** (Tinkerclaw Sleep Consolidation) — incident → pattern → meta-principle.

### Category 6 — Decay / lifecycle

- [ ] **"Cleaning Lady" cron** — scheduled automated enforcement of storage budgets (`runDecayPass` is on-demand only).
- [ ] **50KB storage budget per folder** (Tinkerclaw) — per-category size caps with LRU eviction to enforce.
- [ ] **14-day archival threshold** (Tinkerclaw).
- [ ] **3-day compression window for daily logs**.
- [ ] **Ebbinghaus forgetting curve** (MemoryBank) — alternative decay model to Weibull. Low priority; current Weibull works.

### Category 7 — Importance scoring

- [ ] **4-component importance** (Tinkerclaw) — entity_density(3.0) + decision_signals(3.0) + user_engagement(2.5) + recency(1.5). Replaces current category+length heuristic.
- [ ] **Importance log-modulation in scoring** — `effective = cos_sim × (1 + 0.15 × log(1 + importance × 10))`. v12 has a variant; Tinkerclaw formulation is slightly different.

### Category 8 — Diversity / MMR

- [x] ~~Dialog-aware MMR-lite (session-key based)~~ — `applyDialogDiversity()` shipped in v16, gated by `QMD_RECALL_DIVERSIFY=on` (non-RAW) and tonight's `QMD_MEMORY_MMR=session` (RAW-compat). Awaiting phase-4 n=500 signal.
- [ ] **Embedding-based MMR upgrade** — replace session-key key-grouping with cosine-based similarity for precision on paraphrased duplicates. Needs memory-to-memory cosines (either cached or computed on the fly). Note: ROADMAP cat 8 also mentions a v12 Jaccard MMR variant — not present in current code, may have been removed or never landed.
- [ ] **Task-conditioned scoring** (Tinkerclaw Total Recall) — `premise · phase · supersession · task_rel`. Adds context-dependent ranking.

### Category 10 — Knowledge graph

- [x] ~~Direct KG injection in recall with smart gating~~ — **already shipped** as `QMD_RECALL_KG=on`. See Category 2 entry.
- [ ] **GraphRAG community-based hierarchical KG** — Louvain communities over the KG for multi-hop summarization.

### Category 13 — Auto-capture / hooks

- [ ] **Claude Code message-count triggers** (every 15 messages) — MemPalace pattern. Low-hanging UX win for CC integration.
- [ ] **PreCompact emergency save hook** — MemPalace pattern. Dump session state before Claude's context compaction.

### Category 16 — Push / pull

- [x] ~~Push Pack pattern~~ (Tinkerclaw Total Recall) — **already shipped** as `pushPack()` (`src/memory/index.ts:1400`). Returns Task State + core-tier memories + hot-tail (recently accessed) + time markers in one bundle. Not wired into eval pipelines.
- [ ] **Agent self-directed recall vs archival routing** (Letta). Needs two-tier storage (§Category 1).

### Category 17 — Eviction

- [~] **True LRU-K** (Tinkerclaw) — `runEvictionPass` uses an LRU-K-flavored backward window (`lruWindowDays`, default 7d) per `src/memory/decay.ts:135-189`. The docstring is honest: "True LRU-K would track the K-th most recent access; a single-field window is the best we can do without a per-memory access history." Real LRU-K still requires schema change to add an access_log table.
- [ ] **LIRS / Belady baselines** — theoretical upper bounds for eviction comparison. Low priority.

### Category 18 — Reflection / self-improvement

- [ ] **Reflexion-style verbal RL on memory** — agent updates memory based on outcome. Major architecture change.
- [x] ~~Periodic reflection~~ — **already shipped** via `runReflectionPass`. See Category 11.
- [ ] **3-agent observer/reflector pipeline** (Mastra) — separate from the existing single-pass `runReflectionPass`. Distinct actor/observer/reflector roles.

### Category 19 — Identity / scope

- [ ] **Three-tier scope hierarchy** (Mem0) — distinct session / user / agent tiers. Current QMD has single-string scope.
- [ ] **Persistent persona model** (Tinkerclaw Identity Persistence).

### Category 20 — Cross-session routing

- [ ] **Active cross-session signal routing** (Tinkerclaw Round Table) — promote patterns across scopes. Currently we only have isolation.

### MemPalace-specific gaps

- [ ] **Two-pass assistant retrieval** — detect "you suggested X" → re-search with full text within session. Targets self-referential questions.
- [ ] **Diary mode / topic extraction at ingest** — synthetic topic-tagged doc per ingest.
- [ ] **Expanded rerank candidate pool** — currently 40, MemPalace recommends 20+ with specific filters.

### Mastra-specific gaps

- [ ] **Working memory** (categorized persistent data) — partial; categories defined but no separate persistent store.
- [ ] **Token budgeting with dual thresholds** — 4-layer context stack.

### Letta-specific gaps

- [ ] **Two-tier storage** — see Category 1.
- [ ] **Recursive summarization on eviction** — summarize groups before archiving.

### Tinkerclaw-specific gaps (research finding)

- [ ] **Pre-computed nightly anchor index** for fast inference (Instant Recall).
- [ ] **Append-only event store** (JSONL + ULID) as ground truth alongside SQLite (Total Recall).
- [ ] **Atomic precision guarantees** — hashes/paths/dates/emails survive compaction.

---

## §3 — Infrastructure, tooling, DX

- [ ] **Split `src/cli/qmd.ts`** — confirmed by graphify: 54 nodes, cohesion 0.08. Biggest refactor lever in the repo. Already queued.
- [ ] **Dim-mismatch migration** — detect dimension mismatch in existing DBs, auto-reindex on first query under new defaults. Almost a critical regression during the 2026-04-13 cleanup; untested with real user data.
- [ ] **File watching / `qmd watch` daemon** — auto-reindex on file change.
- [ ] **`qmd dream` CLI command** — consolidation pass exists in OpenClaw plugin; expose as CLI.
- [ ] **`--explain-json` structured output** for query debugging.
- [ ] **Cross-collection tunnels** — auto-detect same-topic collections.
- [ ] **Room traversal graph** — BFS across collections.
- [ ] **`QMD_SANITY_PROBE`** — per-model top-1 cosine distribution sampler at startup, feeds the model-aware floor calibration in §1.
- [ ] **Libuv `UV_HANDLE_CLOSING` shutdown flake** (test/cli.test.ts recall test) — pre-existing Node 25 + better-sqlite3 teardown race. Skipped. Fix when Node 26 lands or upstream resolves.
- [ ] **LOCOMO eval LLM judge** — current F1/EM/BLEU only. Missing LLM-judge grade.

---

## §4 — Parked / low priority

- [ ] **Pluggable storage backend** (`MemoryBackend` interface) — sqlite-vec + pgvector + lancedb first-class. Parked until multi-tenant deployment or 1M+ memories per scope demand it.
- [ ] **GraphRAG community summaries** (low priority — Category 10 KG injection is higher value).
- [ ] **LIRS / Belady eviction baselines** (theoretical, no production signal).
- [ ] **Reflexion verbal-RL loop** (major architecture change for unclear win).

---

## §5 — Graphify findings (surfaced 2026-04-13)

Items the graph flagged that aren't in the official roadmap categories:

- [ ] **`TransformersRerankBackend`** — new high-degree node expected once cross-encoder rerank lands. Already tracked as #1 in §1.
- [ ] **Community "CLI Commands" refactor** — 54 nodes, cohesion 0.08. See §3.
- [ ] **Community "Project Concepts + Benchmarks"** — 45 nodes, cohesion 0.05 — weak clustering because it's conceptual docs, not code. No action.
- [ ] **Isolated HyDE / Qwen3 / Parallel Search nodes** — docs-only concept nodes with no code attachment. Can be wired in when those features land, or left as research notes.

---

## §6 — Open questions the night didn't answer

- [ ] Does fixed MMR show any signal at n=500 on either mxbai or arctic-s? (phase 4 in flight)
- [ ] Does the adaptive cosine floor ratio need to be model-family-specific, or can we just lower the default from 0.5 to 0.3 globally without hurting fp32 models? **A global lower bound experiment** is one n=500 run away.
- [ ] Per-turn ingest changes the entire benchmark substrate (5-10x memories per scope). Does that change the R@5 curve, or does it just shuffle the same ranking problem onto finer chunks?
- [ ] MemPalace reaches 96.6% R@5 / 100% multi-session on LME _s via `ChromaDB.EphemeralClient()` per question. QMD's `scope = question_id` is the functional equivalent. Why is there still a 12-14pp multi-session gap after partition fixes + embed swap + expansion? Hypothesis: MemPalace doesn't use adaptive cosine gating — they return all memories in the scope and let reranking sort it. Worth testing: flat floor (keep top-50) + keyword boost only, no adaptive filter.

---

**When to update this file:** after every A/B that changes the default config,
every commit that adds or deletes an item in §1-§5, and every session that
surfaces new optimization candidates from graphify / eval data. Keep the boxes
accurate — tomorrow's plan depends on it.
