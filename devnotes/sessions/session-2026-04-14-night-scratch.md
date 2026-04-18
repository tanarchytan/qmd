# Night 2026-04-13 → 2026-04-14 scratch

Working doc. Folds into ROADMAP.md when results land.

## New retrieval levers shipped (env-gated, off by default)

| Flag | Feature | LME applicability | Expected lift |
|---|---|---|---|
| `LOTL_MEMORY_EXPAND=entities` | Sub-queries from proper-noun entities + keywords | Weak (low entity density in LME) | 0-2pp on workloads with rich named entities |
| `LOTL_MEMORY_EXPAND=keywords` | Sub-queries from top-N keyword groups of 2 | **Strong candidate** — no entity dependency, fans out on topical keywords | 2-8pp on multi-session |
| `LOTL_MEMORY_SCOPE_NORM=rank` | Rank-normalize similarities within each scope before adaptive gate | **Noop on LME** (scope = question_id, single scope per query). Kept for multi-project qmd workloads | 0pp on LME, 2-5pp on multi-scope recalls |
| `LOTL_MEMORY_MMR=session` | Session-diversity MMR: penalize repeat picks from same `metadata.source_session_id` | **Strong candidate** — directly targets the multi-session category where right answers span N sessions | 3-8pp on multi-session |

## Key discovery: LME scope model

```
// evaluate/longmemeval/eval.mts:379
const scope = inst.question_id;
```

Every LME question maps to ONE scope. Multi-session retrieval is intra-scope multi-session — the 50 session chunks are all in the same question's scope. This means:
- Scope-norm can't help LME (needs ≥2 scopes in candidate pool)
- Session-diversity MMR is the right tool (works within a single scope by source_session_id)
- Query expansion is valuable if it surfaces different session candidates per sub-query

## Open optimization candidates surfaced tonight (to add to ROADMAP)

### Category 2 — Multi-Pass / Hybrid Retrieval
- **Cross-encoder rerank via transformers.js** (planned Phase 3 per session handoff). Replace LLM rerank with local ONNX cross-encoder. `mixedbread-ai/mxbai-rerank-base-v1` ONNX ~80 lines new backend.
- **Entity graph traversal with smart gating** — was rolled back in v8 due to generic-entries domination. Could retry with stricter entity density threshold + scope filter.

### Category 4 — Chunking Strategy
- **Per-turn ingest A/B on LME** — currently `LOTL_INGEST_PER_TURN=off` is the default. Testing `on` would create one memory per conversation turn, increasing memories-per-scope from ~50 to ~500 and giving finer-grained retrieval. Low cost, high potential on multi-session.
- **800-char chunk experiment** (already queued). Test against MemPalace's sizing.

### Category 6 — Decay / Lifecycle
- **Cleaning Lady cron / storage budgets** — `runDecayPass` works on demand only. Scheduled automated enforcement missing.

### Category 7 — Importance Scoring
- **4-component importance** (entity density + decision signal + engagement + recency) replacing the current category+length heuristic. Tinkerclaw's formulation outperforms single-axis scoring.

### Category 8 — Diversity / MMR
- **Session-diversity MMR** (shipped tonight). Embedding-based upgrade from Jaccard would need pairwise cosines during rerank; possibly worth it if session-diversity A/B wins.
- **Embedding-based MMR upgrade** from Jaccard token similarity. Precision gain on paraphrased duplicates.

### Category 10 — Knowledge Graph
- **KG-in-recall with adaptive gating** — v8 rolled back blunt injection. Could retry with entity density threshold + max-facts cap + scope filter. Currently KG is consolidated into memory chunks only.

### Category 11 — Synthesis / Post-retrieval
- **Hindsight-style `reflect` pass** — one LLM call after top-K retrieval to synthesize an answer context. Queued as v16 candidate in ROADMAP. High-impact, remote-LLM dependent.

### Category 13 — Auto-Capture / Hooks
- **Claude Code message-count triggers + PreCompact hook** — MemPalace has these, QMD doesn't. Low-hanging UX win for the Claude Code integration path.

### Category 16 — Push / Pull
- **Push Pack** — Task State / hot tail / time markers proactively injected. Currently only auto-recall via hooks fires; no proactive context assembly.

### Category 17 — Eviction
- **True LRU-K** (vs current LRU-1). Track K most recent access timestamps instead of just the last one. Theoretical improvement; unclear if production data shows the gap.

### Category 18 — Reflection / Self-Improvement
- **Periodic reflection over stored memory streams** (Generative Agents pattern). Currently only extraction-time reflection.
- **3-agent observer/reflector pipeline** (Mastra).

### Category 19 — Identity / Scope
- **Distinct session / user / agent tier hierarchy** (Mem0's 3-tier scope). QMD uses single-string scope.
- **Persistent persona model** (Tinkerclaw Identity Persistence).

### Category 20 — Cross-Session Routing
- **Active signal routing across scopes** (Tinkerclaw Round Table). We have isolation, not routing.

### New candidates from tonight's investigation

- **Scope-norm promotion path** — once multi-project qmd deployments exist, flip default on. For now ships flag-off.
- **Adaptive cosine floor tuning per model family** — mxbai-xs q8 returns mem=10-40 under the floor `max(0.05, top1*0.5)` while MiniLM-L6 fp32 returns mem=44-50. The floor heuristic needs model-awareness or a per-model calibration env var (`LOTL_VEC_FLOOR_RATIO`).
- **Matryoshka dimension retrieval** — store 768-dim, query at 384 if model supports it (nomic does). Quality scales with dim retention; cost stays at 384d KNN. Dead on transformers.js today because the 768d OOM bugs kill it before we can try.
- **Multi-dtype A/B on arctic-xs** — tonight confirmed arctic-xs q8 loads healthy at int8/uint8/q4 too. Testing int8/uint8 at n=500 is the mxbai-xs q8 ceiling rematch we haven't done yet. **Queued for tomorrow if tonight's A/Bs don't land.**

## Results fill-in sections (TBD after evals)

### arctic family n=500 table

| Model | dim | R@5 | R@10 | MRR | multi-session R@5 | Wall |
|---|---|---|---|---|---|---|
| **mxbai-xs q8** (ref from handoff) | 384 | 94.2% | 94.4% | 0.857 | 82% | 14m49s |
| **MiniLM-L6 uint8** (ref from handoff) | 384 | 94.4% | 94.8% | 0.859 | 83% | 17m09s |
| arctic-xs q8 | 384 | TBD | TBD | TBD | TBD | TBD |
| arctic-s q8 | 384 | TBD | TBD | TBD | TBD | TBD |

### Multi-session A/B table — mxbai-xs q8 n=100 (Phase 1)

| Config | avg_mem | R@5 | MRR | multi-session |
|---|---|---|---|---|
| baseline | 10.0 | 98.0% | 0.937 | 93% |
| expand-kw | **11.3** | 98.0% | 0.937 | 93% |
| mmr-session | 10.0 | 98.0% | 0.937 | 93% |
| expand-kw + mmr | **11.3** | 98.0% | 0.937 | 93% |

**Phase 1 findings (flags verified firing, metric saturated):**
- Expansion (keywords) pulls +1.3 memories per query — sub-queries reach new candidates. Flag works.
- MMR alone is a pure noop — not because the code is broken, but because **the pool is only 10 memories**. MMR has no diversity to select from.
- n=100 metric fully saturated at 98%/93% — even if MMR/expansion fix 1 question, the shift is within noise.

**New bottleneck surfaced: adaptive cosine floor is too aggressive on tight-cluster q8 models.**
- mxbai-xs q8 has high top-1 cosines → floor = `max(0.05, top1 × 0.5)` → ~0.42 → most candidates rejected.
- The floor heuristic was tuned on looser-distribution MiniLM fp32 where mem=44-50 is normal.
- MMR needs a larger pool to demonstrate. Phase 3 relaxes with `LOTL_VEC_MIN_SIM=0.1`.
- **This finding is itself a commit-worthy roadmap item**: `LOTL_VEC_FLOOR_RATIO` env var or per-model calibration table.

### Multi-session A/B table — mxbai-xs q8 n=500 (Phase 3, MMR bug)

| Config | R@5 | R@10 | MRR | multi-session | Wall |
|---|---|---|---|---|---|
| baseline | 94.2% | 94.4% | 0.857 | 82% | 15m12s |
| + EXPAND=keywords | 94.2% | 94.6% | 0.858 | **83%** | 14m56s |
| + LOTL_VEC_MIN_SIM=0.1 (loose) | 94.2% | **95.2%** | 0.858 | 82% | 14m58s |
| + loose + MMR (buggy) | 94.2% | 95.2% | 0.858 | 82% | 14m58s |
| + loose + EXPAND + MMR (buggy) | 94.2% | 95.0% | 0.858 | **83%** | 15m36s |

**Phase 3 findings:**
- `LOTL_MEMORY_EXPAND=keywords`: **+1pp multi-session** — first positive code-side lever on LME.
- `LOTL_VEC_MIN_SIM=0.1` (loose floor): **+0.8pp R@10** but no R@5 shift. Extra candidates live at rank 6-10; they're not cracking top-5 because the same mxbai-xs hits crowd the top.
- **MMR bug discovered post-run**: stored `metadata` is a JSON string, not an object. My hand-rolled MMR cast it and always got `undefined` for `source_session_id`. Reinvented `applyDialogDiversity()` which already exists and does exactly this correctly via `memoryDialogKey()`. Fixed in commit `1def426`: deleted the hand-rolled block, reused `applyDialogDiversity` with a new RAW-compatible gate.

### Multi-session A/B table — Phase 4 (fixed MMR + arctic-s)

| Config | model | R@5 | R@10 | multi-session | Wall |
|---|---|---|---|---|---|
| mxbai-xs + loose + expand + FIXED mmr | mxbai-xs q8 | TBD | TBD | TBD | TBD |
| arctic-s + expand | arctic-s q8 | TBD | TBD | TBD | TBD |
| arctic-s + loose + expand + FIXED mmr | arctic-s q8 | TBD | TBD | TBD | TBD |

### Commits landed tonight

- `87d4f32` chore: rip Qwen3/LlamaCpp/fastembed leftovers (cleanup)
- `7dc7c1e` chore: drop src/bench-rerank.ts (cleanup followup)
- `ff26021` feat(memory): zero-LLM multi-query expansion LOTL_MEMORY_EXPAND=entities
- `fd87442` feat(memory): three multi-session retrieval levers (scope-norm + keyword expand + session MMR)
- `1def426` fix(memory): MMR reuses applyDialogDiversity, lift RAW gate

### Honest verdict on MMR (will update post-phase 4)

If fixed MMR still shows no lift at n=500: the 83% ceiling isn't a diversity problem — it's a ranking problem where the WRONG sessions rank higher than the right ones. No amount of diversification fixes that. The real fix is then either a better embed (arctic-s shows this works: +2.2pp from model swap) or cross-encoder rerank. That's tomorrow's work.

If fixed MMR shifts multi-session: keep it, promote to default for multi-source-dialog workloads.

### Verdict (TBD)

Writes itself based on table above. Ship winners, park null results, note discoveries.
