# Upstream cherry-pick log — tobi/qmd → tanarchytan/lotl

**Why this file exists.** We forked tobi/qmd to build the memory layer.
The fork has diverged enough that a straight merge is no longer practical
(node-llama-cpp removed, memory system added, scope partition key, embed
backend rewrite, ~5 night sessions of retrieval work). But upstream still
ships fixes we want.

**The pattern:** periodically audit upstream commits since the last sync,
pick the ones that are post-cleanup-compatible, skip the ones that touch
removed surface area, and log everything here so future audits can pick up
where the last one left off.

**Audit cadence.** No fixed schedule. Trigger on either:
- A new upstream release announcement, or
- A reported bug in our fork that might already be fixed upstream, or
- ~3 months since last sync.

**How to add a new audit cycle to this log:**
1. `git fetch upstream`
2. `git log --oneline upstream/main ^dev --since="<last sync date>" --no-merges --grep="^fix"`
3. For each commit, classify as: cherry-picked / already had / skipped / deferred
4. Cherry-pick the picks, update the table below, commit with `chore(upstream): sync N commits` style

**Upstream remote:** `https://github.com/tobi/qmd.git`
**Our remote:** `https://github.com/tanarchytan/lotl.git`

---

## Sync history

| Date | Upstream HEAD | Last sync base | Our branch | New commits | Picked | Skipped | Deferred | Audit notes |
|---|---|---|---|---|---|---|---|---|
| 2026-04-07 | (v2.1.0) | initial fork | `dev @ c846ac7` | — | — | — | — | `chore: merge upstream v2.1.0` — full merge, not a cherry-pick audit |
| 2026-04-14 | `cfd640e` | `c846ac7` (2026-04-07 v2.1.0 merge) | `dev @ 87424b0` | **13** | 4 | 7 | 2 | First post-cleanup audit. **100% coverage** of the 13 truly new commits since the v2.1.0 merge. |

---

## Cherry-picked commits

Format: upstream hash → our commit, with a one-line rationale.

### 2026-04-14 audit

| Upstream | Our commit | Subject | Why |
|---|---|---|---|
| `77e71d0` | `87424b0` | fix: USERPROFILE fallback for Windows HOME | Critical for Windows MCP subprocess case where Claude Code passes USERPROFILE but not HOME |
| `9dd8a73` | `87424b0` | fix(mcp): enableProductionMode before getDefaultDbPath | SDK consumers importing MCP server directly hit the production-mode guard otherwise |
| `0adbdeb` | `87424b0` | fix(store): surface actionable sqlite-vec guidance | Tracks `_sqliteVecUnavailableReason` so error messages include original cause |
| `17074ea` | `87424b0` | fix: include line in CLI --json search output | JSON consumers can navigate to the right source line |

---

## Already had (verified during audit, no action needed)

Verified during audit — these were already in our tree, usually from a
prior upstream merge (in our case the 2026-04-07 v2.1.0 merge).

### 2026-04-14 audit (pulled in via v2.1.0 merge)

| Upstream | Subject | Where it lives in our tree |
|---|---|---|
| `09a4d19` | fix(store): error on embedding dimension mismatch (#501) | `src/store/db-init.ts:286-291` |
| `ef062e1` | fix(multi-get): brace expansion glob (#424) | `src/cli/qmd.ts:957`, `src/store/documents.ts:483` |
| `0212363` | fix(mcp): read version from package.json (#431) | `src/mcp/server.ts:98` |

---

## Skipped (post-cleanup incompatible)

These touch surface area we removed in the 2026-04-13 cleanup
(node-llama-cpp + fastembed + Qwen3 detection + GGUF model loading).
Re-evaluate ONLY if we re-add the corresponding subsystem.

### 2026-04-14 audit

| Upstream | Subject | Why skipped |
|---|---|---|
| `cfd640e` | fix(test): resolve LLM test timeouts by disabling file parallelism | Test file we deleted with the LlamaCpp removal |
| `e4990e4` | Harden embedding overflow handling | LlamaCpp `truncateToContextSize` hardening + `chunkDocumentByTokens` recursive guard. Both target surface we removed (no LlamaCpp class, no `llm.tokenize` in chunking — we use char heuristic). |
| `f53ee26` | fix: detect non-GGUF model files | We removed node-llama-cpp; no GGUF loading path |
| `1ecb5c9` | Fix LOTL_LLAMA_GPU backend override handling | `LOTL_LLAMA_*` env vars removed in cleanup |
| `26e3d0c` | fix(status): avoid build attempts during device probe | Device probe was LlamaCpp-specific, removed |
| `fee576b` | fix: migrate legacy lowercase paths on reindex | Part of handelize chain (see below) |
| `9fb9de4` | fix: preserve original case in handelize() | Part of handelize chain (see below) |

**Handelize chain context:** upstream's `9fb9de4` → `9c9de94` → `828823d` → `fee576b` is a "tried to remove `.toLowerCase()`, broke things, reverted, added migration for the broken window" cycle. We never participated in that experiment — our `src/store/documents.ts:50` always had `.toLowerCase()` — so the entire chain is a no-op for us.

**Older audit hits (skipped during prior merge cycles, listed for reference):**

| Upstream | Why skipped (still applies) |
|---|---|
| `6db34d7` fix(llm): catch GPU init failures, fall back to CPU | llama.cpp specific |
| `8644fa9` fix(store): thread embed model URI to format functions | Uses `isQwen3EmbeddingModel` detection which we ripped out 2026-04-13 |
| `54550a3` fix(llm): explicit embed context size, env-configurable | llama.cpp specific |

---

## Deferred (worth porting in a separate session)

Real improvements that need more than a one-line patch — ported when there's
time to do them properly + add tests.

### 2026-04-14 audit

| Upstream | Subject | Why deferred | Effort estimate |
|---|---|---|---|
| `8404cc3` | fix(uri): include index in custom qmd links | Adds index segment to `lotl://` URI parsing so CLI commands can switch indexes inline. Requires schema change to `VirtualPath` type (add optional `indexName` field) plus call sites in get/multi-get. | ~30-60 min code + tests |
| `3023ab3` | fix: bump transitive deps for security alerts | Need to cross-reference against our `package-lock.json` since dep set diverged after node-llama-cpp removal. May require updating multiple deps independently. | ~30 min audit + npm audit fix |

---

## Audit playbook (for future sessions)

```bash
# 1. Get upstream HEAD
git fetch upstream
git log -1 --format="%h %ar : %s" upstream/main

# 2. List fixes since the last sync date in this file
git log --oneline upstream/main ^dev \
  --since="<last sync date>" \
  --no-merges \
  --grep="^fix" \
  | head -40

# 3. For each commit, inspect:
git show <hash> --stat
git show <hash> -- src/<file>

# 4. Decide: pick / already had / skip / defer
# 5. Apply pick, run typecheck + targeted tests
# 6. Update this file's sync history table + cherry-picks list
# 7. Commit with "chore(upstream): sync N commits" or fold into a fix commit
```

**Skip rules** (reject without further analysis):
- Anything touching `src/llm/local.ts`, `src/llm/loader.ts`, `src/llm/pull.ts`,
  `src/llm/fastembed.ts` — those files don't exist in our fork.
- Anything fixing `LOTL_LLAMA_*` env vars — we removed those.
- Anything touching `LlamaCpp.getDeviceInfo()` or related GPU probe code.
- Anything in `formatQueryForEmbedding` / `formatDocForEmbedding` Qwen3 branches —
  the Qwen3 conditional was removed 2026-04-14.
- Anything in upstream's CI/nix flake config — we have our own.

**Pick rules** (default-accept unless they touch the skip list):
- `fix(store)` not touching node-llama-cpp
- `fix(mcp)` lifecycle / startup race fixes
- `fix(cli)` user-facing bugs
- `fix(uri)` / `fix(path)` portability fixes (Windows, WSL, etc.)
- Security dep bumps (after independent verification)
- Test infrastructure fixes that don't depend on our removed surface area

**Conflict resolution philosophy:**
- Prefer applying the upstream patch as a fresh edit rather than `git
  cherry-pick` which can introduce phantom conflicts from divergent context.
- If upstream's fix lives in a file we restructured (e.g. they patched
  `src/store.ts:X`, we have `src/store/db-init.ts:Y`), find the equivalent
  function in our tree and apply the same logic.
- Always typecheck + run the closest test file after each pick.
- Commit each upstream batch separately so the cherry-pick history is
  attributable.
