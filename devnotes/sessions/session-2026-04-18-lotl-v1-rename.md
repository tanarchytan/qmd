# Session handoff — 2026-04-18 — Lotl v1.0.0 rename + cleanup

**Purpose of this handoff:** the parent conversation is being compacted. When it resumes, start from "Next up" below.

---

## What shipped this session

### 1. Full rename `qmd` → `lotl` for v1.0.0

- Package: `@tanarchy/qmd@2.1.0-dev.23` → **`@tanarchy/lotl@1.0.0`**
- CLI binaries: `lotl` (canonical) + `qmd` (alias for legacy installs)
- Env vars: `LOTL_*` everywhere (was `QMD_*`)
- Config dir: `~/.config/lotl/` (was `~/.config/qmd/`)
- Cache dir: `~/.cache/lotl/` (was `~/.cache/qmd/`)
- Virtual path scheme: `lotl://collection/path` (was `qmd://...`)
- File/dir renames:
  - `src/cli/qmd.ts` → `src/cli/lotl.ts`
  - `bin/qmd` → `bin/lotl`
  - `skills/qmd/` → `skills/lotl/`
  - `setup/setup-qmd.sh` → `setup/setup-lotl.sh`
  - `hooks/qmd_*_hook.sh` → `hooks/lotl_*_hook.sh`
  - `assets/qmd-architecture.png` → `assets/lotl-architecture.png`
  - `evaluate/amb-bench/qmd.py` + `run_qmd.py` → `lotl.py` + `run_lotl.py`
  - `finetune/data/qmd_*.jsonl` → `lotl_*.jsonl`
- MCP server `name: "lotl"` in `src/mcp/server.ts`
- Help text hero: `lotl — Living-off-the-Land memory for AI agents`
- Embedded skill (`src/embedded-skills.ts`) regenerated from `skills/lotl/SKILL.md` with `name: lotl` + `allowed-tools: Bash(lotl:*), mcp__lotl__*`

### 2. Tests

- Started session with 113 failures (all caused by rename-induced assertion mismatches).
- Systematically fixed test assertions + one real bug (`slice(4)` → `slice(5)` in `normalizeVirtualPath` after `qmd:` → `lotl:` scheme change).
- **Final: 758 pass / 17 skip / 0 fail.**
- Skipped tests categorized into 4 buckets in `devnotes/sessions/` (this file doesn't repeat; see `## Skipped tests — 17` below).
- Added opt-in guards for 3 LLM-dependent tests in `test/mcp.test.ts` (skipIf missing `LOTL_QUERY_EXPANSION_PROVIDER` / `LOTL_RERANK_PROVIDER` / `LOTL_EMBED_BACKEND`).

### 3. NPU removal (just completed — step 1 of the current cleanup cycle)

- Removed `hasNpu` field from `GpuCapabilities` interface in `src/llm/gpu-probe.ts`
- Removed NPU detection PowerShell filter (`Get-PnpDevice | Where-Object { NPU|XDNA|IPU }`)
- Removed the "AMD XDNA NPU detected... VitisAI EP is Python-only" warning
- Docs cleaned: `docs/ARCHITECTURE.md`, `docs/TODO.md` (Phase 11.6 marked CANCELED), `docs/ROADMAP.md`, `docs/notes/embedder-candidates.md`
- Reason: VitisAI EP is Python-only, no Node binding; never actually ran NPU inference. Detection was just a warning no one could act on.
- Re-open trigger: first-class Node NPU runtime appears.

### 4. devnotes/ scaffold (just completed — step 2)

```
devnotes/
├── README.md              ← index + conventions
├── embedders/             ← embedder A/Bs, HF catalog
├── metrics/               ← R@5 audit, metric discipline
├── architecture/          ← design decisions pre-promotion
├── sessions/              ← this file lives here
└── archive/               ← retired experiments
```

Each subfolder has a `.gitkeep`. Empty so far except this handoff.

---

## Next up — step 3 and onward

**Step 3: migrate `docs/notes/` → `devnotes/`** (the file moves).
Per-domain mapping I already planned:

| Source file | Destination |
|---|---|
| `docs/notes/embedder-candidates.md` | `devnotes/embedders/embedder-candidates.md` |
| `docs/notes/metrics.md` | `devnotes/metrics/metric-discipline.md` |
| `docs/notes/multi-agent-vector-backend.md` | `devnotes/architecture/multi-agent-vector-backend.md` |
| `docs/notes/random-findings-online.md` | `devnotes/archive/random-findings-online.md` |
| `docs/notes/archive/amb-bench-prep.md` | `devnotes/archive/amb-bench-prep.md` |
| `docs/notes/archive/baselines-audit-20260414.md` | `devnotes/sessions/session-2026-04-14-baselines-audit.md` |
| `docs/notes/archive/night-20260414-roadmap-draft.md` | `devnotes/sessions/session-2026-04-14-night-roadmap-draft.md` |
| `docs/notes/archive/night-20260414-scratch.md` | `devnotes/sessions/session-2026-04-14-night-scratch.md` |
| `docs/notes/archive/night-phase5-plan.md` | `devnotes/archive/night-phase5-plan.md` |
| `docs/notes/archive/pluggable-storage.md` | `devnotes/architecture/pluggable-storage.md` |
| `docs/notes/archive/qwen3-embedding-paths.md` | `devnotes/embedders/qwen3-paths.md` |

After the moves, delete `docs/notes/` (the folder). Verify `docs/EVAL.md` link to `docs/notes/metrics.md` gets updated to `devnotes/metrics/metric-discipline.md`.

**Step 4: slim `CHANGELOG.md`**. Currently 1384 lines / 74 sections. Keep only `[1.0.0]` + `[Unreleased]`. Move everything before into `devnotes/sessions/CHANGELOG-pre-v1.md`. Add a link from `CHANGELOG.md` top pointing at the history file.

**Step 5: expand v0→v17 version table in README**. Two-column metric split:
- Left column: sr5 (pre-audit, what we reported at the time)
- Right column: rAny@5 + fractional R@5 (post-audit, what we'd report today)
Data lives in `docs/ROADMAP.md` history section.

**Step 6: add direct-ORT backend test** — `test/transformers-embed-direct.test.ts`, opt-in via `LOTL_RUN_TRANSFORMERS_TEST=1` env var (same pattern as `test/transformers-rerank.test.ts`).

Total remaining: ~1h15m. All steps end with `tsc --noEmit && vitest run` green.

---

## Current state (for resume)

```
package: @tanarchy/lotl@1.0.0
build:   npm run build → exit 0
tsc:     tsc --noEmit → exit 0
tests:   758 pass / 17 skip / 0 fail
tarball: tanarchy-lotl-1.0.0.tgz, 523 kB, 211 files
eval DBs retained: 5 (mxbai-xs baseline + 4 sweep candidates) = 12 GB on disk
```

Git: working tree has uncommitted changes from the rename + cleanup. User hasn't requested a commit yet — **do not commit unless asked**.

---

## Critical context for the next session

### What Lotl is (in one paragraph)

Lotl = renamed + heavily-augmented fork of [tobi/qmd](https://github.com/tobilu/qmd) into a memory framework. Forked 2026-04-04; renamed 2026-04-18 (today). David's first commits were cloud-LLM config; the memory layer (KG, Weibull decay, fact extraction, honest-eval harness, RRF pipeline) was written from scratch over ~6 focused days. mxbai-xs q8 is the validated production embedder default (Phase 11.8 sweep, n=500 LongMemEval). Shipping winner numbers: **98.4% rAny@5 / 0.917 MRR / 81.4% Judge-Acc LoCoMo** (with gemini-2.5-flash gen+judge; gpt-4o gen reaches 64% on LME matching paper baseline).

### The rename policy

- **User-facing**: everything should say Lotl/`lotl`/`LOTL_*`
- **Backward compat**: `qmd` CLI binary works as alias; `QMD_*` env vars are NOT read — the `LOTL_*` switch is a hard break (user explicitly chose "first time right, replace them anyway")
- **Code internals**: renamed aggressively (env.ts now reads `LOTL_*` prefix only, path.ts only accepts `lotl://` scheme)

### Things deliberately NOT changed

- OpenClaw plugin manifest name (`tanarchy-lotl`, was `tanarchy-qmd`) — renamed successfully
- GitHub repo URL in `package.json` is already `github.com/tanarchytan/lotl` (repo rename on GitHub is a user action the user needs to do manually — I've updated package.json to the target URL; it'll 404 until the actual repo rename)

### Rules that stick

- **Zero-async at storage layer** (Jiti-safe — no top-level await anywhere in import chain, `src/db.ts` uses synchronous `createRequire()`)
- **Cloud-first dispatch** with optional local embed. `LOTL_EMBED_BACKEND=transformers` opts into local ONNX via `@huggingface/transformers`.
- **mxbai-xs q8 is the permanent production default** (Phase 11 concluded). Don't reopen unless new int8 ONNX + MTEB retrieval ≥65 ships.
- **Eval harness lives at `evaluate/`** and is NOT shipped in the npm package (confirmed via `files` whitelist).
- **User prefers caveman style** — short answers, no filler, direct.

### Canonical scripts (post-cleanup)

```
evaluate/scripts/
  sweep-n500-embedders.sh     ← n=500 LME sweep of 4 candidates
  sweep-jina-v5.sh            ← jina-v5 via direct-ORT backend, standalone
  sweep-locomo-convs.sh       ← conv-26 + conv-30 across embedders
  sweep-locomo-full.sh        ← full 10-conv LoCoMo
  probe-jina-v5.mts           ← RSS fail-fast probe
  probe-jina-v5-rss.mts       ← stress test
  inspect-lme-db.mjs          ← diagnostic
evaluate/legacy/              ← 24 archived one-off scripts
```

### Reference docs shipped

- `evaluate/SNAPSHOTS.md` — pinned v1.0 metrics + reproduction recipes
- `evaluate/locomo/HYBRID_HARNESS.md` — honest-harness design (why top-k=10 not 50, etc.)
- `evaluate/CLEANUP_PLAN.md` — 16-step release-ready plan (most executed)

---

## Skipped tests — 17 (for reference)

**Bucket 1 — LLM-gated (5):** `test/mcp.test.ts` hybridQuery (4) + memory_add+search round-trip (1). Skip when `LOTL_QUERY_EXPANSION_PROVIDER` / `LOTL_RERANK_PROVIDER` / `LOTL_EMBED_BACKEND` not set.

**Bucket 2 — Opt-in transformers rerank (2):** `test/transformers-rerank.test.ts`. Skip unless `LOTL_RUN_TRANSFORMERS_TEST=1`.

**Bucket 3 — Windows-incompatible (9):** `test/cli.test.ts` mcp http daemon block (6) + skill symlink tests (2) + `store.helpers.unit.test.ts:getRealPath` (1). All `skipIf(process.platform === "win32")`.

**Bucket 4 — Intentional skip (1):** `test/cli.test.ts > CLI Memory Commands > recall returns no memories message`. Pre-existing, flaky teardown.

---

## Known issues not addressed in v1.0

- Rerank default off (`LOTL_MEMORY_RERANK=off`) because RRF pipeline + cross-encoder blend regresses. Tracked in `src/store/constants.ts:74` as KNOWN LIMITATION pending score normalization. Validated on old additive pipeline (+1-2pp MRR), but that pipeline is gone.
- `DEP0190` warning fires during Windows CLI subprocess tests (shell:true + args). Security advisory only, not functional. Removing shell:true breaks Windows tsx dispatch. Deferred.
- Major dep updates deferred: `typescript 5.9→6.0`, `vitest 3.2→4.1`, `@types/node 22→25`, `tree-sitter-* 0.23→0.25`. Safe updates (zod, web-tree-sitter) applied.
- No dedicated test for `src/llm/transformers-embed-direct.ts` (300 LOC new code, covered only by smoke probe). Plan in step 6.

---

## Resume command

When the compacted conversation picks back up, the exact next step is:

> **Step 3: migrate `docs/notes/` files into `devnotes/` per-domain.**
> Apply the 11-row mapping table above. After moves, delete empty `docs/notes/` directory, update `docs/EVAL.md` link that references `docs/notes/metrics.md`, then `tsc --noEmit && vitest run` to confirm green.

Session handoff ends here.
