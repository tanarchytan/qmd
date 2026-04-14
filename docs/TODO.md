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

**2026-04-14 night post-mortem on the sweep:** phase 4 ran 3 of the levered configs on mxbai + arctic-s at n=500 (results in ROADMAP night section). Phase 5 + 5b + 5c + phase-5 variants all died to WSL crash / background-task reaping / Gemini quota cool-downs — the chains never completed. Per-turn ingest is still **untested at any size** after the eval harness overran WSL's memory cgroup. `QMD_RECALL_KG_RAW=on` ships as a gate tonight but never got an n=500 pass. Memory reflect / runReflectionPass / pushPack / runTieredRecall remain as-shipped-but-unwired. Next session: single short `run_in_background` jobs only; no chains; workers ≤ 2.

---

## §1 — Single-session-preference gap attack (active v17 goal)

> **Retargeted 2026-04-14 post-metric-audit.** The old "82% multi-session
> ceiling" was a r5 (token-overlap) artifact — on sr5 multi-session has
> been at 100% the whole time. The real remaining gap vs MemPalace is
> **single-session-preference at 90.0% sr5 vs MemPalace's 96.7% (−6.7pp)**.
> This section now targets that bucket. See ROADMAP "v17 priority shift"
> and footnote (c) for the full audit.

### Parked levers (already tested at n=500, flat on preference sr5)

- [x] **`QMD_MEMORY_EXPAND=keywords`** — zero-LLM keyword fanout. n=500 result: 90.0% preference sr5 (tied with baseline). Moves overall 98.2 → 98.0 (tiny regression). Parked for preference.
- [x] **`QMD_VEC_MIN_SIM=0.1` loose floor** — +0.2pp on overall sr5, **flat on preference** (90.0%). Still the production default for the overall lift, but does not close the preference gap.
- [x] **`QMD_MEMORY_MMR=session`** — RAW-compat dialog diversity. n=500: 98.4% overall, 90.0% preference. Tied with loose-floor baseline.
- [x] **Cross-encoder rerank** (`cross-encoder/ms-marco-MiniLM-L6-v2` via `transformers.js`) — shipped 2026-04-14 (commit `773b079`), n=500 A/B (`d3da644`): **flat on sr5** (98.4% overall, 90.0% preference). r5 preference jumped 90→100% (lexical rerank finds better in-session passages) but sr5 is unchanged — the failure is at candidate generation, not rerank. Flagged off. Code retained for future use cases.

### Root-cause diagnostic (2026-04-14, post-cross-encoder)

Ran `evaluate/preference-rank-diagnostic.mts`: for each of the 30 preference
questions, embed with `mxbai-xs q8`, no-cutoff vec0 KNN against the question
scope, find the rank of the correct `source_session_id`. **All 30 correct
sessions are in the candidate pool. Coverage is 100%. The failure is
ranking, not generation.** Vector-only sr5 = 83.3% (25/30 in top-5);
production sr5 with BM25/RRF climbs to 90.0%. The 5 vector misses sit at
ranks 6, 8, 12, 39, and one BM25 recovers. See ROADMAP "v17 root-cause
diagnostic" section for full distribution + per-question rank list.

**This invalidates the entire candidate-generation queue below.** All
levers in the previous version of this section (HyDE, per-turn ingest,
LLM query expansion, multi-vector, candidate pool size, floor calibration)
attack a problem that does not exist. The candidates are there. Cross-
encoder rerank failed not because the right session was missing from its
top-40 input, but because cross-encoders re-score by lexical relevance and
the **wrong** session has more verbose assistant text overlapping the
query than the **right** session has user-turn text.

### Queued experiments (v17, post-diagnostic)

- [ ] **L1 (user-turns-only) ingest variant** — strip assistant turns from session text before embedding. Mechanism: improves the embedding centroid of the right session, since the user's preference statement now carries the centroid weight instead of being drowned in the assistant's 500-token verbose response. Schift's "L# cache hierarchy" credits this with +3pp R@1 and 100% preference (`docs/notes/random-findings-online.md` §3). Implementation: branch in `evaluate/longmemeval/eval.mts:404` ingest path, or a real `QMD_INGEST_USER_ONLY=on` flag in the memory store. Pure local, no LLM, no new backend. Priority: **highest**.
- [ ] **L# (L0+L1+L2) score blend** — if L1 alone over-corrects (loses cases where L0 assistant-side signal mattered), add the Schift blend `0.5×L1 + 0.3×L2 + 0.2×L0` as a query-time score fusion across two ingest variants. Priority: **medium**, gated on L1 alone result.
- [ ] **Preference-aware rerank** — only reachable if L1+L# don't close the gap. Either a cross-encoder fine-tuned on preference pairs, or a query-side rewrite that emphasizes preference predicates ("user prefers X" template injection). Priority: **low**, fallback only.

### Parked (post-diagnostic)

The candidate-generation queue from the previous version of this section
is all parked — diagnostic proves coverage is 100% and these levers attack
the wrong problem:

- ~~HyDE / local generative query expansion~~ — coverage already 100%, won't help.
- ~~Remote LLM query expansion~~ — same.
- ~~Per-turn ingest~~ — same. Smaller chunks don't change which sessions are reachable; sr5 is session-granularity.
- ~~Wider candidate pool / `limit * N`~~ — top-40 already contains 28/30 right sessions. The 2 remaining ones are at ranks 39 (HS reunion, MemPalace also misses) and 1 BM25-recovered. Widening the pool to 100 would catch the rank-39 case but only if rerank can correctly promote it, which is the same cross-encoder failure mode.
- ~~Multi-vector / ColBERT~~ — refactor cost not justified; the ranking issue is centroid-quality not multi-vector matching.
- ~~Model-aware floor calibration~~ — `QMD_VEC_MIN_SIM=0.1` already provides a manual escape hatch, and the 5 vector misses are not at the floor.

---

## §2 — Technique parity with reference systems

Items that other memory systems ship and QMD doesn't. Sorted by expected signal
on LME-class workloads.

### Category 2 — Multi-pass / hybrid retrieval

- [x] ~~**Cross-encoder rerank**~~ — shipped 2026-04-14 via `transformers.js` (`src/llm/transformers-rerank.ts`). n=500 A/B flat on sr5; flagged off; see §1 parked-levers list.
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
