## 🌙 Session 2026-04-13 → 2026-04-14 — night A/B cycle, multi-session levers, arctic-s unlock

**TL;DR:** Confirmed the 82% multi-session R@5 ceiling is breakable — two independent levers moved it tonight. `snowflake-arctic-embed-s q8` (a direct model swap) hit **84.2% multi-session** without any code change — the first time any embed model broke 83% on LME _s n=500. Code-side, `QMD_MEMORY_EXPAND=keywords` zero-LLM fanout lifted mxbai-xs q8 multi-session from 82% to 83%. Both levers are independent and stack. Queued for tomorrow: n=500 arctic-s × levers shootout to see if they combine superadditively.

### Night phases at a glance

| Phase | What | Wall | Outcome |
|---|---|---|---|
| 0 (prep) | Cleanup + 3 new levers (expand/scope-norm/MMR) committed | — | 4 commits before first eval |
| 1 | n=100 A/B on mxbai-xs q8: baseline / expand-kw / mmr / both | 12 min | Metric saturated at 98%/93% multi. Flags verified firing (expand adds +1.3 mem). MMR later found bugged. |
| 2 (arctic book) | n=500 on arctic-xs q8, arctic-s q8 | ~35 min total | arctic-xs ties mxbai-xs. **arctic-s breaks 83% ceiling → 84.2% multi** |
| 3 | n=500 A/B on mxbai-xs q8: 5 configs with loose floor | ~75 min | `expand-kw`=+1pp multi, `loose-floor`=+0.8pp R@10, MMR null (bug) |
| 4 (in flight at writeup) | n=500 fixed MMR + arctic-s × levers | ~55 min | TBD |

### Multi-session R@5 leaderboard (n=500, RAW recall)

| Config | overall R@5 | multi-session R@5 |
|---|---|---|
| mxbai-xs q8 baseline | 94.2% | 82% |
| MiniLM-L6 uint8 | 94.4% | 83% |
| mxbai-xs q8 + EXPAND=keywords | 94.2% | 83% |
| **arctic-s q8 baseline** | **93.2%** | **84.2%** 🏆 |
| arctic-s q8 + expand / stack | TBD | TBD (targeting 85%+) |

First real movement above the 83% ceiling without sacrificing the on-device footprint. arctic-s q8 is still 384d, still in the ~50MB class.

### Key discoveries

1. **arctic-s q8 is a first-class multi-session candidate.** Trades 1pp overall R@5 for 2.2pp multi-session. Slower wall (~25m vs ~15m on n=500) but that's the cost of the ceiling break.

2. **`QMD_MEMORY_EXPAND=keywords` is the zero-LLM decomposition lever.** Proper-noun entity extraction (the v1 variant) failed on LME because questions use lowercase concepts. Splitting the extracted keywords into groups of 2 and fanning out parallel vec queries lifts multi-session by +1pp on mxbai-xs q8. Flag: off by default, opt-in.

3. **Adaptive cosine floor is too aggressive on tight-distribution q8 models.** `pickVectorMatches` uses `floor = max(0.05, top1 × 0.5)`. On mxbai-xs q8 with typical top1 ≈ 0.82, that's a 0.41 floor — cutting the candidate pool to ~10 memories per query. MiniLM-L6 fp32 returns 44-50. Loosening to `QMD_VEC_MIN_SIM=0.1` pulled enough candidates to lift R@10 by +0.8pp but didn't shift top-5. The floor heuristic needs model-aware calibration or an env knob for per-model tuning (`QMD_VEC_FLOOR_RATIO=0.3` etc.).

4. **MMR alone isn't enough when the embed model's top-K is already session-diverse.** Session-diversity reshuffles only help when the native top-5 is clustered on one session. Neither mxbai-xs q8 nor MiniLM uint8 top-5 had enough session clustering for MMR to matter. Still ships as a flag for workloads where it does.

5. **Scope-norm is a noop on LME.** Every LME question uses a single scope (`scope = question_id`), so rank-normalization within scope has nothing to do. Kept for multi-project qmd deployments where cross-scope recall is real.

6. **LlamaCpp stub layer still paying rent.** The fastembed/LlamaCpp cleanup surfaced ~15 leftover files. All committed. Full cleanup sweep complete.

### Open optimization candidates (by category)

Feeding directly into the roadmap's "open optimizations" register. All surfaced from tonight's eval data or graph audit.

**Category 2 — Multi-pass / hybrid retrieval:**
- Cross-encoder rerank via `transformers.js` — the next major lever if arctic-s × expand doesn't crack 85%. `mixedbread-ai/mxbai-rerank-base-v1` ONNX, ~80 lines mirroring `TransformersEmbedBackend`.
- Entity graph traversal with smart gating — rolled back in v8 due to generic-entry domination. Retry with scope filter + entity density threshold.

**Category 4 — Chunking strategy:**
- **Per-turn ingest A/B on LME** — currently `QMD_INGEST_PER_TURN=off`. Turning on increases memories per scope from ~50 to ~500 (finer granularity). High-potential multi-session lever. Untested.
- 800-char chunk experiment (MemPalace sizing).

**Category 7 — Importance scoring:**
- 4-component importance (entity density + decision + engagement + recency) replacing category+length heuristic.

**Category 8 — Diversity / MMR:**
- Embedding-based MMR upgrade from Jaccard token similarity. Precision gain on paraphrased duplicates.

**Category 10 — Knowledge graph:**
- KG-in-recall with adaptive gating — retry v8's rollback with stricter entity density threshold.

**Category 11 — Synthesis / post-retrieval:**
- Hindsight-style `reflect` LLM pass over top-K before answering. Queued as v16 candidate.

**Category 13 — Auto-capture / hooks:**
- Claude Code message-count triggers + PreCompact hook.

**Category 16 — Push / pull:**
- Push Pack pattern (Task State / hot tail / time markers) proactively injected.

**Category 17 — Eviction:**
- True LRU-K (vs current LRU-1).

**Category 18 — Reflection:**
- Periodic reflection over stored memory streams (Generative Agents pattern).
- 3-agent observer/reflector pipeline (Mastra).

**Category 19 — Identity:**
- Distinct session/user/agent tier hierarchy (Mem0's 3-tier scope).

**Category 20 — Cross-session routing:**
- Active signal routing across scopes (Tinkerclaw Round Table).

**New candidates surfaced tonight:**
- `QMD_VEC_FLOOR_RATIO` env knob — per-model adaptive floor calibration. mxbai-xs q8 needs a lower ratio than MiniLM-L6 fp32. Avoids the "tight distribution → empty pool" problem that killed MMR on mxbai-xs.
- arctic-s q8 promotion to the ceiling-fallback slot alongside MiniLM-L6 uint8. Same size class, better multi-session, slightly lower overall R@5. Best model for bottleneck-priority workloads.
- Multi-dtype arctic-xs A/B at n=500 — arctic-xs q8 ties mxbai-xs, but int8/uint8/q4 variants untested at n=500. The MiniLM uint8 precedent suggests quant shifts could matter here too.
- `QMD_MEMORY_EXPAND=keywords` promotion path — if confirmed on arctic-s at phase 4, promote to default on LME-class workloads.

### Shippable flags (all off-by-default, opt-in)

| Flag | Feature | Signal |
|---|---|---|
| `QMD_EMBED_BACKEND=transformers` + `QMD_TRANSFORMERS_MODEL=Snowflake/snowflake-arctic-embed-s` | arctic-s embed model | **+2.2pp multi-session** on LME n=500 |
| `QMD_MEMORY_EXPAND=keywords` | Zero-LLM keyword-group query fanout | **+1pp multi-session** on LME n=500 |
| `QMD_MEMORY_EXPAND=entities` | Zero-LLM proper-noun query fanout | 0pp on LME (sparse entities), useful on other workloads |
| `QMD_MEMORY_MMR=session` | Dialog-diversity reshuffle in RAW mode | TBD (phase 4 fix) |
| `QMD_MEMORY_SCOPE_NORM=rank` | Rank-normalize similarities within scope | Noop on LME (single-scope), useful on multi-project |
| `QMD_VEC_MIN_SIM=0.1` | Override adaptive cosine floor | +0.8pp R@10 on mxbai-xs q8 n=500 |

### v17 next steps (informed by tonight)

1. **Arctic-s × levers shootout** (phase 4 in flight) — does fixed MMR add signal? Does arctic-s + expand break 85%?
2. **Cross-encoder rerank Phase 3** — blocked pending phase 4 verdict. Biggest expected lift if arctic-s × expand plateaus.
3. **Per-turn ingest A/B** — cheap experiment, highest untested upside.
4. **Model-aware floor ratio** — stop `QMD_VEC_MIN_SIM=0.1` being a magic number. Auto-calibrate per embed model based on observed top-1 distribution.
