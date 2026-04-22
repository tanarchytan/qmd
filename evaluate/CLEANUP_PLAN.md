# Lotl Release-Ready Cleanup Plan

**Scope:** all cleanup to eval harnesses + src/ codebase in one linear pass. Execution starts once jina-v5 n=500 finishes and BEFORE any LoCoMo / downstream sweeps.

**Approach:** each step is self-contained, typechecks and tests green at the end of each, zero runtime behavior change (feature-preserving refactor + documentation).

**Total estimate:** ~9-11 hours + ~45 min eval time.

---

## Competitor audit (reference — informs Step 10)

### Judge LLM configs

| System | Model | Temp | Max tokens | Prompt style | Labels | Notes |
|---|---|---|---|---|---|---|
| snap-research (canonical) | — | — | — | rule-based F1, stemmed overlap | F1 float | No LLM judge |
| **Mem0** | gpt-4o-mini | 0.0 | unspecified | "generous, topic match" | JSON `{label:"CORRECT"\|"WRONG"}` | Skips category 5 |
| **Zep** | gpt-4o-mini | 0 | unspecified | same as Mem0 | Pydantic `Grade(is_correct, reasoning)` | Near-identical to Mem0 |
| **Hindsight** | GPT-OSS-120B | 0.0 | unspecified | binary correctness | 0/1 | Self-hosted 120B |
| MemPalace | not disclosed | — | — | — | — | — |
| memory-lancedb-pro | no judge published | — | — | — | — | — |
| **Lotl current** | gpt-4o (via Poe) | 0 | 48 | "strict but fair" | JSON `{correct:bool, reason:str}` | Stricter than Mem0/Zep |

### Retrieval + generator context caps (honest-top-k picture)

| System | Retrieval pool | Memories to LLM | Per-memory char cap |
|---|---|---|---|
| Mem0 paper / code | 10 / 30 | 10 / 30 | none |
| Zep | not disclosed | not disclosed | none |
| Hindsight | "token budgets" | not disclosed | none |
| MemPalace honest | 10 | 10 | none |
| MemPalace cheat | 50 (>sessions) | 50 | none |
| memory-lancedb-pro | 10 / 20 | 3 (auto) / 10 (CLI) | none |
| **Lotl (post-today fix)** | 50 | **10** both LME + LoCoMo | 6000 chars (LME) |

---

## Execution steps (linear)

Do in order. Each step ends with: `npx tsc --noEmit && npx vitest run test/` green before proceeding. Revert if any gate fails.

### Step 1 — Baseline green typecheck (30-45 min, low risk, RELEASE-BLOCKING)
Currently `npx tsc --noEmit` exits non-zero with **30 errors in test/**. Release-ready bar fails immediately. Fix first so every subsequent step has a meaningful gate.

- [ ] Bulk-add `.js` extensions to all `test/*.ts` relative imports (test/eval.test.ts, eval-bm25.test.ts, mcp.test.ts, rrf-trace.test.ts, store.helpers.unit.test.ts)
- [ ] Fix TS5097 at `test/cli.test.ts:16:42` (rename `.ts` → `.js`)
- [ ] Type-annotate the ~10 implicit-any callbacks in test/eval.test.ts + test/mcp.test.ts (all `Parameter 'r' implicitly has an 'any' type` style)
- [ ] Fix `test/multi-collection-filter.test.ts:81:12` Object-possibly-undefined
- [ ] `npx tsc --noEmit` must exit 0
- [ ] `npx vitest run test/` must be green

**Gate:** typecheck + full test suite green.

### Step 2 — Full env-var consolidation (2-3h, medium risk, RELEASE-BLOCKING)
**No backward compatibility.** Every `QMD_*` env var gets one of four verdicts: KEEP / ADAPTIVE / HARDCODE / DELETE. Apply uniformly across `src/`, `evaluate/`, scripts, `.env.example`, and docs in the same pass.

**Audit categories:**

| Verdict | Criteria | Action |
|---|---|---|
| **KEEP** | API keys, URLs, provider choices, opt-in features with real user value | Single canonical name + doc'd in .env.example |
| **ADAPTIVE** | Value can be computed from environment / hardware / model config | Remove env var, compute dynamically, hardcode fallback |
| **HARDCODE** | Default is the only sensible value, no user ever tunes it | Replace reads with literal, delete env var |
| **DELETE** | Zero src/ readers (zombie) or replaced by better mechanism | Remove from scripts + ablation logs |

**Sub-steps:**

2a. **Generate audit table.** `grep -rohE "QMD_[A-Z_]+" src/ evaluate/` → sort-uniq → for each, classify with `grep -rn "LOTL_FOO" src/` to count readers. Document verdict per var.

2b. **DELETE zombies** (confirmed 0 src/ readers):
  - [ ] `LOTL_INGEST_EXTRACTION`, `LOTL_INGEST_REFLECTIONS`, `LOTL_INGEST_SYNTHESIS`, `LOTL_INGEST_PER_TURN`
  - [ ] `LOTL_RECALL_DUAL_PASS`, `LOTL_RECALL_LOG_MOD`
  - [ ] Remove from every `run-*.sh` export, remove from `ablation` log object in both `eval.mts` files

2c. **HARDCODE rarely-tuned knobs** (single validated value, no tuning rationale):
  - Candidates (verify zero real-world tuning during audit):
    - `LOTL_VEC_MIN_SIM` — 0.1 is night-2026-04-13 validated; keep as env? Or hardcode? **Decide during audit — likely KEEP because users do override**
    - `LOTL_GEMINI_EMBED_BATCH_SIZE`, `LOTL_GEMINI_EMBED_INTERVAL_MS` — hardcode to current values unless rate-limit tuning needed
    - `LOTL_CHUNK_SIZE_TOKENS`, `LOTL_CHUNK_WINDOW_TOKENS` — tuning these breaks memory recall. Hardcode to validated values.
    - `LOTL_PROMPT_RULES` — after Step 5 purges v11.1/v12, only v11 and v13 remain. If v13 is the new default for --judge runs, the var may collapse to a two-valued decision that CLI flag can own. **Hardcode if eval default is clear; otherwise KEEP as enum**.
  - [ ] For each HARDCODE, delete the env read, replace with constant, delete docstring/comment about tuning

2d. **ADAPTIVE replacements** (compute, don't knob):
  - [ ] `LOTL_EMBED_MICROBATCH` — already set by `embed-sizer.ts::computeEmbedBudget`. Remove the env read fallback; sizer is source of truth.
  - [ ] `LOTL_EMBED_MAX_WORKERS` — same. Sizer sets it.
  - [ ] `LOTL_TRANSFORMERS_DEVICE=auto` — already does probe-based selection. Make `auto` the default and remove the env read for the non-auto paths (keep `cpu`/`webgpu`/`dml` as explicit user choice but default is auto).
  - [ ] `LOTL_RECALL_MAX_SIM`, `LOTL_RECALL_MIN_SIM` (if present) — check if adaptive based on pool top1 exists; if so, remove env.

2e. **Consolidate aliases** (single canonical name, NO backward compat):
  - [ ] `LOTL_TRANSFORMERS_EMBED` (composite) vs `LOTL_TRANSFORMERS_MODEL` + `LOTL_TRANSFORMERS_FILE` (triple) — **pick one**. Composite is easier UX. Keep `LOTL_EMBED_MODEL` as the canonical, parse `<repo>/<file>` if present. Delete the triple from src + scripts.
  - [ ] `LOTL_EMBED_MODEL` vs `LOTL_TRANSFORMERS_MODEL` — the backend prefix is implied by `LOTL_EMBED_BACKEND`. Unify on `LOTL_EMBED_MODEL`.
  - [ ] Any `QMD_*_PROVIDER` vs `QMD_*_BACKEND` duplication — pick one term across all operations
  - [ ] Document the naming convention at the top of `.env.example`: `{OPERATION}_{ATTRIBUTE}` (e.g. `LOTL_EMBED_MODEL`, `LOTL_RERANK_PROVIDER`)

2f. **src/memory/index.ts rename** `getFastEmbedBackend` → `getLocalEmbedBackend` (misleading name — loads `TransformersEmbedBackend` post-2026-04-13 cleanup). Update 3 call sites.

2g. **Stale comments cleanup** (in same pass since they reference env vars we may delete):
  - [ ] `src/cli/format.ts:6` — claims qmd.ts is 3,379 LOC; it's 2724
  - [ ] `src/memory/index.ts:131` — "See TODO §1" — chase or drop
  - [ ] `src/store/constants.ts:70` — "TODO next session" (normalization) — implement or delete
  - [ ] `src/memory/extractor.ts:331` — "DEPRECATED standalone path" — delete the dead code, not just the label
  - [ ] `src/llm.ts:10-12` — post-fastembed-removal comments (keep, historical context)

2h. **Consistency pass:**
  - [ ] Every env var has one read site OR a single resolver fn (`getEnvBool`, `getEnvInt`, etc.)
  - [ ] All env reads go through a consistent validator (`src/env.ts` if it exists, else add one)
  - [ ] No unused imports left after deletions

2i. **Gate:** `npx tsc --noEmit && npx vitest run test/` green. Run n=20 LME `--no-llm` and confirm top-line R@5/MRR matches pre-cleanup result (nothing runtime-observable should have changed unless we intentionally adapted a value, in which case document why).

**Expected reduction:** 66 → ~35 env vars (estimate). Deletion targets: 4 ingest + 2 recall zombies + ~10 adaptive + ~6 hardcoded + ~5-8 consolidated aliases.

### Step 3 — tsconfig.build.json exclude fix (5-10 min, trivial)
Stale pattern excludes a file that doesn't exist.

- [ ] Change `"src/bench-*.ts"` → `"src/bench/**"` so it matches the real location (`src/bench/bench.ts`)
- [ ] Update CLAUDE.md line that claims `src/bench-*.ts` is excluded
- [ ] Gate green (build-only check: `npm run build` completes).

### Step 4 — Extract `evaluate/lib/` shared modules (90-120 min, low risk, RELEASE-BLOCKING)
Both `evaluate/longmemeval/eval.mts` and `evaluate/locomo/eval.mts` inline-duplicate providers, judge, metrics. Extract.

- [ ] Create `evaluate/lib/llm.ts` — port `LLM_CONFIG`, `askLLM`, `askOpenAICompat`, `askGemini`, `askMiniMax` + `LLMProvider` type. Single `createLLMClient(provider, opts)` factory.
- [ ] Create `evaluate/lib/judge.ts` — `askJudge` + Lotl-strict prompt. Export `buildJudgePrompt(style: "qmd")` (Mem0/Zep styles added in Step 10).
- [ ] Create `evaluate/lib/metrics.ts` — consolidate F1/EM/SH/tokenize/normalizeAnswer/R@K/SR@K/DR@K/MRR/NDCG/Cov-*. Same function signatures as current inline copies.
- [ ] Create `evaluate/lib/cache.ts` — thin re-export of `src/llm/cache.ts` with path-sanity helpers.
- [ ] Create `evaluate/lib/config.ts` — single source of truth for `ANSWER_TOP_K`, `ANSWER_MAX_CHARS`, `RETRIEVAL_POOL` etc. with env-var parsing.
- [ ] Replace inline code in both `eval.mts` files with imports. Line count should drop ~30-40%.
- [ ] Gate green.

### Step 5 — Purge dead answer-prompt versions (20-30 min, low risk)
LME eval has v11/v11.1/v12/v13. Only v11 (default) + v13 (--judge runs) actively used.

- [ ] Inspect `buildAnswerPrompt` branches in `evaluate/longmemeval/eval.mts`
- [ ] Delete v11.1 and v12 branches (orphaned per TODO.md Phase 7.2 verdict: "Prompt style was NOT the bottleneck")
- [ ] Keep v11 (default, for F1/EM runs) + v13 (recommended for --judge runs)
- [ ] Update `LOTL_PROMPT_RULES` enum to `"v11" | "v13"`
- [ ] Gate green (smoke: run n=10 LME at each version, confirm results match prior).

### Step 6 — Dead-comment purge in src/ (30-45 min, low risk)
15 files with >3-line `//` blocks. Most are docstrings (keep). 4-6 look like zombie code fragments — review & delete if code.

- [ ] `src/llm/remote.ts:639-649` (11 lines) — review + delete if code
- [ ] `src/llm/remote.ts:224-227`, `:266-270`, `:564-567`, `:571-575` — review + delete if code
- [ ] `src/llm/transformers-rerank.ts:62-69`, `:84-89` — review + delete if old fallbacks
- [ ] `src/llm/gpu-probe.ts:37-41`, `:111-114` — review + delete if vendor experiments
- [ ] Anything >6 lines of commented code → delete
- [ ] Gate green.

### Step 7 — Silent-catch annotations (20-30 min, zero risk)
13 `catch {}` blocks in src/. Add one-line comment explaining WHY each swallow is correct.

- [ ] `src/cli/qmd.ts:159`, `:177`
- [ ] `src/memory/index.ts:614`, `:2003`, `:2028`
- [ ] `src/openclaw/plugin.ts:117`, `:270`, `:285`, `:478`
- [ ] `src/store/db-init.ts:277` (idempotent ALTER TABLE migration)
- [ ] No logic changes, just comments — preserves behavior
- [ ] Gate green.

### Step 8 — `as any` cast audit (45-75 min, medium risk)
29 sites total. Categorize each + minimize.

- [ ] Categorize: (a) unavoidable external API e.g. `(tf as any)`, (b) lazy-import without proper types, (c) actual type smell
- [ ] Fix category (b) by adding minimal `.d.ts` declarations or targeted type imports
- [ ] Fix category (c) by proper typing — often small method signature tweaks
- [ ] Keep (a) with inline comment explaining WHY
- [ ] Target: drop from 29 → <12 casts
- [ ] Gate green (critical — this touches typing, tests MUST pass).

### Step 9 — Local LLM provider support (Ollama / vLLM / Lemonade / LM Studio) (60-90 min, low risk, NEW-FEATURE)
**User ask.** Currently `QMD_*_PROVIDER=api` with manual URL/key works but is gnarly. Add shorthand.

Current `OperationProvider = 'api' | 'url' | 'gemini'`. Ollama/vLLM/Lemonade/LM Studio all serve OpenAI-compatible endpoints, so they already work via `provider=api` — but need:
1. No-auth mode: `apiKey?: string` optional (local servers don't require)
2. Shorthand providers that auto-configure URL/key/model defaults

Proposed change to `src/llm/remote.ts`:

```ts
export type OperationProvider = 'api' | 'url' | 'gemini' | 'ollama' | 'vllm' | 'lemonade' | 'lm-studio';
```

Each shorthand maps to a preset:
- `ollama` → url=`http://localhost:11434/v1`, apiKey optional (accepts any string)
- `vllm` → url=`http://localhost:8000/v1`, apiKey optional
- `lemonade` → url=`http://localhost:8000/api/v1` (AMD default), apiKey optional
- `lm-studio` → url=`http://localhost:1234/v1`, apiKey optional

Steps:
- [ ] Extend `OperationProvider` type + config resolver to fill URL/auth defaults per shorthand
- [ ] Make `apiKey` optional in `OperationConfig` (empty → no Authorization header OR `Bearer dummy`)
- [ ] Ollama-specific embed shim: if `provider=ollama` and `/v1/embeddings` not available, fall back to Ollama's native `/api/embed` (check with one HEAD request at startup)
- [ ] Graceful-down: if local server refuses connection, log once + fall back to `LOTL_EMBED_BACKEND=transformers` (local ONNX)
- [ ] Update `src/remote-config.ts` to accept the new shorthand strings
- [ ] Add a health-check probe method `RemoteLLM.pingLocal()` for test runs
- [ ] Document in `.env.example` (Step 14)
- [ ] Gate green + integration smoke: if Ollama is available locally, run one query-expansion call via `LOTL_QUERY_EXPANSION_PROVIDER=ollama`; skip if not available

### Step 10 — Competitor judge parity mode (60-90 min, medium risk, NICE-TO-HAVE)
Our "strict but fair" prompt biases Judge-Acc lower than Mem0/Zep's "generous". Add parity mode so we can report apples-to-apples vs published scores.

- [ ] Add `buildJudgePrompt(style: "qmd" | "mem0" | "zep")` in `evaluate/lib/judge.ts`:
  - `mem0`: verbatim port of `evaluation/metrics/llm_judge.py` prompt (already captured in this plan)
  - `zep`: near-identical to Mem0 per extraction above
  - `qmd`: current "strict but fair" (default)
- [ ] Add `--judge-style mem0|zep|qmd` CLI flag to both evals (default `qmd`)
- [ ] Wire verdict-parsing for each style (Mem0 → `{label:"..."}`, Zep → structured Grade, Lotl → `{correct:bool}`)
- [ ] Script `evaluate/scripts/compare-judges.sh` runs n=100 each style against winner config, reports Judge-Acc deltas
- [ ] Gate green.

### Step 11 — Consolidate evaluate/ scripts (45-60 min, low risk, RELEASE-BLOCKING)
29 scripts in evaluate/. Archive legacy, promote keepers.

- [ ] Create `evaluate/scripts/` and `evaluate/legacy/`
- [ ] Promote keepers:
  - `run-n500-sweep.sh` → `evaluate/scripts/sweep-n500-embedders.sh`
  - `run-jina-v5-fixed.sh` → `evaluate/scripts/sweep-jina-v5.sh`
  - `run-locomo-conv26-30.sh` → `evaluate/scripts/sweep-locomo-convs.sh`
  - `probe-jina-v5-direct.mts` → `evaluate/scripts/probe-jina-v5.mts`
  - `probe-jina-v5-rss-stress.mts` → `evaluate/scripts/probe-jina-v5-rss.mts`
  - `inspect-lme-db.mjs` → `evaluate/scripts/inspect-lme-db.mjs`
- [ ] Archive 23 legacy to `evaluate/legacy/` with `evaluate/legacy/README.md` explaining each was a one-off ablation runner now superseded
- [ ] Update `docs/EVAL.md` + `docs/TODO.md` paths
- [ ] Gate green.

### Step 12 — test/ file organization (15-20 min, zero risk, NICE-TO-HAVE)
Mixes `.test.ts` with Containerfile + shell smoke tests.

- [ ] `test/Containerfile` → `test/smoke/Containerfile`
- [ ] `test/smoke-install.sh` → `test/smoke/install.sh`
- [ ] `test/launcher-detection.test.sh` → `test/smoke/launcher-detection.sh`
- [ ] Add `test/smoke/README.md` explaining the smoke-test subdir
- [ ] `test/*.test.ts` stays at root for vitest auto-discovery
- [ ] Gate green.

### Step 13 — Write `.env.example` from the post-Step-2 canonical set (30-45 min, zero risk, RELEASE-BLOCKING)
Step 2 already shrank the env-var list; this step documents what remains.

- [ ] List of surviving env vars (should be ~35 from the original 66)
- [ ] Group by domain: embed, rerank, queryExpansion, memory, config, eval-only
- [ ] Per var document: name, default, type (bool/string/int/enum), purpose, when-to-change
- [ ] Rewrite `.env.example`:
  - Quick-start block on top (the 4 lines that get you the default-winning config)
  - Full table below, grouped
  - Local-LLM provider block showing Ollama/vLLM/Lemonade examples (from Step 9)
  - Every shell one-liner properly documented
- [ ] Cross-ref from `docs/EVAL.md` and per-eval READMEs (Step 14)
- [ ] Gate green.

### Step 14 — Per-eval READMEs (45-60 min, zero risk, RELEASE-BLOCKING)
`evaluate/longmemeval/` + `evaluate/locomo/` need standalone READMEs.

- [ ] `evaluate/longmemeval/README.md`:
  - Dataset download (link to longmemeval repo)
  - CLI flag reference (--limit, --conv/--ds, --llm, --judge, --judge-model, --judge-style, --tag, --db-suffix, --no-llm, --ingest-only)
  - Env-var table (reference Step 13's .env.example)
  - 3 canonical recipes: (1) `--no-llm` retrieval-only, (2) `--llm gemini --judge gemini`, (3) `--llm poe --judge poe --judge-style mem0`
  - Performance expectations (walltime per n=100, n=500)
- [ ] `evaluate/locomo/README.md`:
  - Dataset download (link to snap-research/locomo)
  - CLI flag reference
  - Recipe set
  - Cross-link to `HYBRID_HARNESS.md`
- [ ] Both READMEs cross-link each other + `CLEANUP_PLAN.md` + `docs/EVAL.md`
- [ ] Brief top-of-file comment block in each `eval.mts` pointing at the README
- [ ] Gate green.

### Step 15 — docs/ drift pass (20-30 min, zero risk)
Skim docs/ for any CURRENT-tense claim now stale post-cleanup.

- [ ] `docs/ARCHITECTURE.md` — verify file paths still correct, Update RRF pipeline diagram if Step 4 affects it
- [ ] `docs/ROADMAP.md` — add entry for this cleanup session
- [ ] `docs/EVAL.md` — update paths to new `evaluate/scripts/` and mention HYBRID_HARNESS.md
- [ ] `docs/SYNTAX.md` — no changes expected (syntax unchanged)
- [ ] `CHANGELOG.md` — add `## [Unreleased]` entry: "refactor(eval): extract shared libs, wire local-LLM providers, rewrite .env.example, archive legacy scripts"
- [ ] Update `CLAUDE.md` if any file path changed
- [ ] Gate green.

### Step 16 — Final verification (15-30 min)
Full smoke before calling cleanup done.

- [ ] `npx tsc --noEmit` → exit 0
- [ ] `npx vitest run test/` → green
- [ ] `npm run build` → succeeds, `dist/cli/qmd.js` shebang present
- [ ] `npx tsx src/cli/qmd.ts --help` → prints help, exits 0
- [ ] Quick retrieval smoke: run n=20 LME `--no-llm` on an existing sweep DB, compare top-line R@5 / MRR to pre-cleanup result (should be byte-identical — we changed zero runtime logic)
- [ ] Quick LoCoMo smoke: conv-26 `--no-llm --limit 10`, compare F1 to pre-cleanup
- [ ] Commit with message: `refactor: release-ready cleanup (steps 1-15)`
- [ ] Update MEMORY.md with a note that cleanup completed

---

## Deferred (explicit out-of-scope for this pass)

These are legitimate future work but NOT release-blocking and NOT required by the current release bar:

- **Monolith splits** — `src/memory/index.ts` (2073 LOC), `src/cli/qmd.ts` (2724), `src/mcp/server.ts` (1611), `src/store/search.ts` (1466), `src/llm/remote.ts` (815). Each is a 2-4h effort. Track as backlog in docs/TODO.md.
- **Phase 6 fact-augmented embedding keys** — separate feature, per CLAUDE.md is a feature not cleanup.
- **evaluate/amb-bench/** — different benchmark, not in current sweep scope.

---

## What this cleanup does NOT change

- Runtime behavior of CLI, MCP, or SDK (no user-visible changes)
- DB schemas or on-disk cache format
- Memory recall pipeline or scoring math
- Any env-var default that code currently reads
- Vector dimensions, chunk sizes, RRF weights — all untouched

Goal: **make Lotl shippable AS-IS.** Cleanup improves maintainability + developer experience + documentation, not recall accuracy.

---

## Timeline vs other work

Sequencing agreed with user:

1. LME n=500 sweep finishes (jina-v5 ~45 min remaining at time of this plan)
2. **All 16 cleanup steps here (~7-9h focused work)**
3. Then proceed with downstream:
   - Step 5 of pipeline (conv-26+30 vs top-3) — uses cleaned-up harness
   - Winner selection
   - Full LoCoMo + full LME vs winner
   - Phase 6 fact-augmented keys
   - Poe API judge runs
