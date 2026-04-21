# Lotl testing runbook — baselines + A/Bs

Reproducible recipes for the eval + sweep workflows we ship. Written
2026-04-19 from the Phase 0-6 optimization session. Everything is
`sweep-flags.sh`-driven; configs are checked in at `evaluate/sweeps/configs/`.

## Prerequisites

One-time setup:

- **Node.js ≥ 22** installed (`.nvmrc` if present)
- **Git Bash** on Windows, bash elsewhere
- Datasets downloaded (not shipped — see [`evaluate/longmemeval/README.md`](../../evaluate/longmemeval/README.md)
  and [`evaluate/locomo/README.md`](../../evaluate/locomo/README.md)):
  - `evaluate/longmemeval/longmemeval_s.json` (~500 questions)
  - `evaluate/longmemeval/longmemeval_oracle.json` (smaller pre-filtered subset)
  - `evaluate/locomo/locomo10.json` (10 conversations)
- **Canonical LME DB**: `evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite`
  — pre-populated with mxbai-xs embeddings, used as the anchor for all
  no-ingest sweeps. Regenerate via the `--ds s --limit 500` eval path
  without `--db-suffix` if lost.
- `.env` at `~/.config/lotl/.env` if you're running LLM-judge sweeps
  (needs `GOOGLE_API_KEY` or `POE_API_KEY` or `MINIMAX_API_KEY`).

## Non-negotiable env settings for all sweeps

These are exported by `sweep-flags.sh` and `sweep-flags-llm.sh` automatically.
If you roll your own runner, match them:

```sh
export LOTL_EMBED_BACKEND=transformers
export LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1
export LOTL_TRANSFORMERS_DTYPE=q8
export LOTL_EMBED_MAX_WORKERS=4
export LOTL_EMBED_MICROBATCH=32
export OMP_NUM_THREADS=4
export LOTL_RECALL_NO_TOUCH=on    # A/B hygiene across shared DBs
```

The `LOTL_RECALL_NO_TOUCH=on` line is load-bearing. Without it,
`access_count` mutations from run N contaminate run N+1's Weibull-decay
ranking. We caught a 4.5pp R@5 false-signal from this on Stage 3 (LoCoMo)
on 2026-04-19.

## Recipe 1 — establish the current baseline

Run the 5-pass deterministic baseline + capture the numbers. Takes ~8 min.

```sh
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/mrr-drift-5-passes.txt \
  --corpus lme --limit 500 --name baseline-repro
```

Outputs land at `evaluate/sweeps/baseline-repro-<timestamp>/SUMMARY.md`.
All 5 passes should produce **byte-identical** metrics (MRR, rAny@5, R@5).
If they drift, something non-deterministic leaked into recall — investigate
before trusting any other sweep.

Current canonical baseline (2026-04-19): **rAny@5 97.8% / R@5 93.4% / MRR 0.907 / NDCG@10 0.904.**

## Recipe 2 — flag ablation (single flag vs baseline)

```sh
# Pick or edit: evaluate/sweeps/configs/flag-sweep-phase1.txt
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/flag-sweep-phase1.txt \
  --corpus lme --limit 500
```

~30 s per config × N configs. Wait for the final summary table — each flag's
delta vs baseline tells you whether it helps / hurts / is null.

**Pitfall — flag polarity:** the polarity for each flag is in
[`env-flag-polarity-reference.md`](env-flag-polarity-reference.md). Wrong
polarity = silent no-op. Common traps:
- `LOTL_MEMORY_MMR=session` — **not `=on`**
- `LOTL_MEMORY_SCOPE_NORM=rank` — **not `=on`**
- `LOTL_MEMORY_SYNONYMS=off` to disable (default ON)
- `LOTL_MEMORY_EXPAND` default is `keywords`, not off

## Recipe 3 — BM25/vec weight re-sweep

Current ship default is `0.9/0.1`. To test other ratios:

```sh
# Edit or use: evaluate/sweeps/configs/bm25-vec-sweep-phase2.txt
# Each row sets LOTL_MEMORY_RRF_W_BM25 and LOTL_MEMORY_RRF_W_VEC explicitly.
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/bm25-vec-sweep-phase2.txt \
  --corpus lme --limit 500 --name weight-sweep
```

Known result (2026-04-19): 9/1 remains optimal on LME. Any shift toward
vec-heavy crashes unless paired with `LOTL_VEC_MIN_SIM=0.0`. See
`devnotes/metrics/flag-sweep-phase1-2026-04-18.md` for details.

## Recipe 4 — reranker A/B (LoCoMo preferred)

**Why LoCoMo, not LME:** LME is ceiling-bound at 98% rAny@5 — no room for
rerank to lift. LoCoMo is R@5 ~52% baseline — hard enough to discriminate.

Add your candidate to `evaluate/sweeps/configs/reranker-sweep-phase3.txt`
(see the parked section at the bottom — un-comment to re-enable the
bigger-param models), then:

```sh
# OPTIONAL: pre-flight probe before committing 2h of CPU
npx tsx evaluate/scripts/probe-rerankers.mts

# Full sweep (single config ≈ 2h15min on Ryzen 7 7840U)
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/reranker-sweep-phase3.txt \
  --corpus locomo --name rerank-ab
```

**Watch progress live:**

```sh
bash evaluate/scripts/watch-rerankers.sh --name rerank-ab &
# Log streams to stdout; a SUMMARY.md diff prints on each new config landing.
```

**One-shot snapshot** (any time during or after sweep):

```sh
bash evaluate/scripts/summarize-rerankers-now.sh --name rerank-ab
# Writes SUMMARY.md in-place and prints the current table.
```

**Ghost-row bug in `summarize-sweep.mjs`:** when a sweep config has a
multi-var env overlay (e.g. `LOTL_MEMORY_RRF_W_BM25=0.7 LOTL_MEMORY_RRF_W_VEC=0.3 LOTL_RERANK_BACKEND=transformers ...`), the parser sometimes
displays the tag as the first env var (e.g. `LOTL_MEMORY_RRF_W_BM25=0.7`)
instead of the actual tag (e.g. `jina-turbo-w73`). Cosmetic only — the
data in the per-config JSON is correct. Check `config.txt` to identify
which reranker that ghost row actually maps to.

**Interpret results:**
- Baseline (no-rerank) R@5 ≈ 52.0%, MRR ≈ 0.411 (on `7/3` weights).
- A reranker is a **keeper** if it lifts MRR by ≥0.01 AND doesn't regress
  R@5. jina-reranker-v1-tiny-en (33M) shipped +4.9pp R@5 / +0.052 MRR
  at 7/3 weights on 2026-04-19.
- Per-query wall-time 4-5 s on CPU. `LOTL_RERANK_STRONG_SIGNAL_SKIP=on`
  mitigates for production latency by skipping rerank when top-1 is
  confidently ranked.

**When to try bigger-param rerankers:** only if the small-model pass
(≤100M) produced at least +0.01 MRR. The 3 parked models
(mxbai-rerank-base 184M, gte-reranker-modernbert-base 149M,
tomaarsen/reranker-ModernBERT-base-gooaq-bce 150M) are commented out
at the bottom of `reranker-sweep-phase3.txt`. Un-comment, re-run the
sweep with the same command.

**Both-sides-normalized blend.** `MEMORY_RERANK_BLEND_ORIGINAL = 0.7`
and `MEMORY_RERANK_BLEND_RERANK = 0.3` are the shipped blend weights
(`src/store/constants.ts:77-78`). Both RRF and rerank scores get min-max
normalized to `[0,1]` before combining (`src/memory/index.ts:1557-1600`).
If you want to re-sweep blend weights, change the constants and re-run.

## Recipe 5 — new embedder candidate

```sh
# Append a row to evaluate/sweeps/configs/*-embedder-sweep.txt or:
LOTL_EMBED_MODEL=<candidate/repo> \
LOTL_TRANSFORMERS_DTYPE=q8 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 500 --workers 4 \
    --db-suffix new-candidate-tag --no-llm
```

**First-run cost:** a new embedder builds its own DB (re-ingests n=500 LME)
and downloads model weights. Allow 30-60 min for ingest. Subsequent
recall-only runs using `--db-suffix new-candidate-tag` skip ingest.

**Winner criteria:** per `devnotes/embedders/embedder-candidates.md` — must
beat mxbai-xs on **both** rAny@5 AND preference MRR (pref MRR is Lotl's
workload-relevant metric). Tied or worse → stay on mxbai-xs default.

**Params/latency cap:** ≤1024 dim (sqlite-vec storage), ≤120M params at
int8 (≤100ms/query CPU). Bigger models ship as opt-in, not default.

## Recipe 6 — LLM-judge evaluation (n=100)

Cheapest useful judge signal. Uses free-tier Gemini.

```sh
# Set GOOGLE_API_KEY in ~/.config/lotl/.env (one-time)
bash evaluate/scripts/sweep-flags-llm.sh \
  evaluate/sweeps/configs/judge-ab-content-flags.txt \
  --corpus lme --limit 100 --name judge-ab
```

Cost: **~$0.20 total** for 100q × 7 configs × 2 calls (gen + judge).
Signal: Judge-Acc delta between baseline and each config. Flags that look
null on retrieval metrics (rAny@5, MRR) can still meaningfully shift
Judge-Acc by changing WHICH memories reach the generator — this is the
test that catches content-effect-only wins.

**Configs to prioritize for judge testing:** flags that affect which
memories get retrieved or their ordering (MMR, SYNONYMS, EXPAND=entities,
SCOPE_NORM=rank). Flags that only affect rank math without changing the
retrieved set (fusion weights, rerank blend) don't need a judge test.

## Recipe 7 — combined winners run

Once individual A/Bs identify winners, stack them:

```sh
# Edit evaluate/sweeps/configs/combined-winners.txt with your stack
# (multi-var overlays are fine: env vars space-separated after the tag)
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/combined-winners.txt \
  --corpus lme --limit 500 --name final-stack
```

Then re-run the same config on `--corpus locomo` — the final ship number
should be consistent across both benchmarks.

## File layout cheat sheet

```
evaluate/
├── scripts/
│   ├── sweep-flags.sh                    ← main runner (no-LLM)
│   ├── sweep-flags-llm.sh                ← LLM-judge variant
│   ├── summarize-sweep.mjs               ← builds diff table per sweep dir
│   ├── summarize-rerankers-now.sh        ← one-shot rerank snapshot
│   ├── watch-rerankers.sh                ← background watcher
│   ├── compare-metrics.mjs               ← byte-identical metric diff
│   ├── smoke-worker-bump.sh              ← Phase 0 worker parity check
│   ├── probe-rerankers.mts               ← load-test rerank candidates before sweep
│   ├── mrr-drift-bisect.sh               ← git-bisect MRR regressions
│   ├── sweep-locomo-full.sh              ← standalone LoCoMo runner
│   ├── sweep-locomo-convs.sh             ← subset LoCoMo (conv-26 + 30)
│   ├── smoke-all-lmstudio.sh             ← LM Studio 4-pair smoke (Recipe 8)
│   ├── smoke-resume-full.sh              ← LM Studio mid-flight resume (cache replay)
│   ├── smoke-resume-locomo.sh            ← LM Studio LoCoMo-only resume
│   ├── smoke-gemma-validate.sh           ← LM Studio gemma-4 A/B vs llama+qwen
│   ├── smoke-followup.sh                 ← A/B/C follow-up orchestrator
│   ├── rejudge-failed.sh                 ← LM Studio rejudge-only pass (after ctx overflow)
│   ├── phase-b-gemma.sh                  ← Phase B full-scale eval on gemma stack
│   ├── phase-b-llama-qwen.sh             ← Phase B full-scale eval on llama+qwen stack
│   ├── wilson-ci.mjs                     ← Wilson Score 95% CIs + distinguishability (Phase C)
│   ├── audit-locomo-goldens.mjs          ← Cross-ref our results vs audit's errors.json
│   └── extract-facts-batch.mjs           ← Phase 5 fact/triple extraction batch runner
├── sweeps/
│   ├── configs/                          ← version-controlled sweep recipes
│   │   ├── flag-sweep-phase1.txt
│   │   ├── bm25-vec-sweep-phase2.txt
│   │   ├── reranker-sweep-phase3.txt
│   │   ├── flag-x-weight-sweep.txt       ← LME combined
│   │   ├── flag-x-weight-locomo.txt      ← LoCoMo combined
│   │   ├── flag-sweep-locomo.txt
│   │   ├── reranker-at-w73.txt
│   │   ├── mrr-drift-5-passes.txt
│   │   ├── mrr-drift-locomo-5-passes.txt
│   │   ├── all-flags-stack.txt
│   │   ├── judge-ab-content-flags.txt
│   │   ├── flag-sweep-corrected.txt      ← polarity-fixed retry
│   │   └── combined-winners.txt
│   └── <name>-<timestamp>/               ← per-run outputs (gitignored)
│       ├── config.txt                    ← copy of input config
│       ├── SUMMARY.md                    ← auto-generated diff table
│       └── <tag>/
│           ├── lme.json                  ← full metrics JSON
│           ├── lme.log                   ← eval.mts stdout
│           ├── lme.wall                  ← elapsed seconds
│           └── overlay                   ← env overlay that was applied
├── longmemeval/
│   ├── eval.mts                          ← LME runner
│   ├── dbs/                              ← pre-populated SQLite per-embedder (gitignored)
│   └── longmemeval_s.json                ← dataset (gitignored)
└── locomo/
    ├── eval.mts                          ← LoCoMo runner
    ├── dbs/                              ← per-conversation SQLite (gitignored)
    └── locomo10.json                     ← dataset (gitignored)
```

## Chained pipelines (overnight)

For multi-hour runs that chain multiple sweeps, use:

- `evaluate/scripts/chained-sweeps.sh` — 6-stage main chain (~3h)
- `evaluate/scripts/follow-up-sweeps.sh` — 8-stage follow-up (~3h)
- `evaluate/scripts/reruns-chain.sh` — replays invalidated stages (~90min)
- `evaluate/scripts/phase6-queue.sh` — Phase 6 squeeze-mxbai-xs chain:
  max-chars → MMR×K → rerank blend α → expand×synonyms (~5.5h LME)
- `evaluate/scripts/phase6-watchdog.sh` — wraps phase6-queue with a
  heartbeat file + 5-retry self-heal on transient exits. Prefer this
  over calling the queue directly for multi-hour runs.

Each chain writes a `MASTER.md` or `SUMMARY.md` triage doc to its own
`evaluate/sweeps/<chain>-<ts>/` directory. Failures don't stop the
chain; each stage logs its outcome.

### Resumable sweeps (2026-04-21)

Historical pain: overnight sweeps die when Claude Code crashes (bash
children get SIGHUP'd with the parent). Prior to 2026-04-21 this meant
losing all partial work in a sweep.

`sweep-flags.sh` is now resume-friendly:

- **Reuses incomplete sweep dirs**: next invocation with the same
  `--name` prefix lands in the most recent incomplete dir (no SUMMARY.md
  present) instead of creating a new timestamped one.
- **Skips completed configs**: `run_one_lme` / `run_one_locomo`
  short-circuit if `<config>/lme.json` or `locomo.json` exists and is
  non-partial.

`phase6-watchdog.sh` adds:

- **Heartbeat file** (`evaluate/logs/phase6-heartbeat.txt`) with
  `<unix-ts> <status>` updated every 60 s while alive.
- **Self-heal**: up to 5 retries on non-zero exit, 30 s backoff.
- **`--status` flag** for quick agent-side liveness probe: prints
  heartbeat age + completed sweeps + in-progress configs.

Agent-side pattern: cron loop at `7 */2 * * *` reads heartbeat, re-fires
`bash evaluate/scripts/phase6-watchdog.sh` if dead. After a Claude
crash, the recovery is just running that command manually — it picks up
where the last config left off.

### Monitor pitfalls (what I got wrong 2026-04-21)

- **Polling the outer queue log mtime is a false signal.**
  `phase6-queue.sh` only prints between-config banners, so its log can
  be fresh only every ~15 min. Watch per-config `lme.log` / `locomo.log`
  mtimes for real liveness, OR the heartbeat file.
- **Monitor tool itself dies with the Claude session.** Not a substitute
  for the OS-level heartbeat. Both layers matter: Monitor for fast
  detection during an alive session, cron + heartbeat for persistence.
- **Claude's background Bash children don't survive Claude restart.**
  Moving to a Windows Scheduled Task or NSSM would fully decouple, but
  adds deploy friction. Current approach: accept the re-invoke cost,
  rely on resume logic to make it cheap.

### Single-instance guard (`phase6-watchdog.sh`)

Back-to-back watchdog fires produce **multiple parallel eval chains all
writing to the same `results-sweep-<tag>.json` file** — racing writes
corrupt the results and double the CPU load. Caught live 2026-04-21
(16 `eval.mts` processes from two watchdogs concurrently running
`k20-mmr-off`).

Prevention: lockfile at `evaluate/logs/phase6-watchdog.lock` holds the
running watchdog's PID. On startup:

1. If the lockfile exists and the recorded PID is alive → exit 0 silently.
2. Otherwise write `$$` into the lockfile, trap `EXIT` to remove it.

**Git Bash pitfall**: `kill -0 <pid>` does NOT work for processes outside
the MSYS session — it returns "No such process" even when `tasklist`
confirms the PID is alive. Use `tasklist //FI "PID eq <pid>" //NH`
instead. See `is_pid_alive()` in `phase6-watchdog.sh`.

Manual seed (when the watchdog is already running but the lockfile is
missing — e.g. fresh clone, or I killed the lock during a panic):

```sh
# Find the watchdog PID:
wmic process where "commandline like '%phase6-watchdog.sh%' and name='bash.exe'" \
  get ProcessId //format:list
# Write it:
echo <PID> > evaluate/logs/phase6-watchdog.lock
```

### Zombie-detection drill (what to run when you're unsure)

```sh
# 1. Count eval.mts processes. Normal = 3-5 (one chain).
#    Anything > 8 = parallel chains = zombies from a past kill / double-fire.
wmic process where "commandline like '%eval.mts%'" get ProcessId //format:list \
  | grep -c "^ProcessId="

# 2. Count watchdog instances. Normal = 1.
wmic process where "commandline like '%phase6-watchdog.sh%' and name='bash.exe'" \
  get ProcessId //format:list | grep -c "^ProcessId="

# 3. Heartbeat age. Fresh = <2 min. Stale = queue died.
cat evaluate/logs/phase6-heartbeat.txt
```

If counts are wrong:

```sh
# Kill all eval.mts node children:
for pid in $(wmic process where "commandline like '%eval.mts%' and name='node.exe'" \
    get ProcessId //format:list 2>&1 | grep "^ProcessId=" | sed 's/ProcessId=//'); do
  taskkill //PID $pid //F 2>&1 | head -1
done
# Then kill duplicate watchdogs by PID, keep the newest.
# sweep-flags.sh resume logic means no redone configs on restart.
```

## Interpretation checklist

After any sweep, check:

1. **Baseline row sanity.** Does the baseline match the canonical number?
   If drift > 1pp on MRR, investigate before trusting any config.
2. **Noise floor.** MRR changes ≤0.005 are noise. Don't declare winners
   under that threshold.
3. **Per-category.** Per-question-type deltas matter. A flag that lifts
   overall MRR but crashes `single-session-preference` is a regression.
4. **Wall-time.** Each config's wall-time should be within ±20% of the
   baseline unless you're changing compute (e.g., adding rerank adds
   ~4 s/query ≈ 2 h per 1986-question LoCoMo conv).
5. **Deterministic?** Two runs of the same config on the same DB should
   produce byte-identical metrics. If they don't, a non-deterministic
   side effect slipped in — check the TOUCH guard, LLM cache, randomness.

## Common gotchas (caught in the 2026-04-18/19 session)

- **TOUCH contamination** across configs sharing a DB. Always export
  `LOTL_RECALL_NO_TOUCH=on` in sweeps (the runners do this automatically).
- **Flag polarity** — `=on` isn't universal. See
  [`env-flag-polarity-reference.md`](env-flag-polarity-reference.md).
- **Reranker filename default** `model_quint8_avx2` only exists on
  `cross-encoder/ms-marco-MiniLM-L6-v2`. For any other reranker, let
  transformers.js auto-resolve — don't override `LOTL_TRANSFORMERS_RERANK_FILE`.
- **Reranker `max_length` cap** at 512. ModernBERT's 8192 default tried
  to allocate 67 GB during cross-attention MatMul and crashed ORT.
  `LOTL_TRANSFORMERS_RERANK_MAXLEN` overrides if needed.
- **Tarball leaks**: `src/graphify-out/` gets shipped if graphify writes
  its cache there. The root `graphify-out/` is gitignored; nested
  `**/graphify-out/` now too (2026-04-19 fix).
- **Mid-run config edits**: bash's `while read < file` snapshots the
  open file descriptor at loop start. Editing the config file mid-sweep
  is unreliable — kill and restart cleanly instead.

## Recipe 8 — LM Studio local LLM-as-judge (full workflow)

Everything we built 2026-04-19 for running LLM-as-judge against a local
LM Studio server (OpenAI-compatible `/v1/*` + native `/api/v1/models/*`
admin endpoints). Zero per-call cost vs Poe/Gemini; full reproducibility
via llm-cache + deterministic temp=0 + seed=42.

### Defaults wired into the harness

- **Host:** `http://10.0.0.113:1234` (override via `LOTL_LMSTUDIO_HOST`)
- **Generator:** `meta-llama-3.1-8b-instruct` Q4_K_M (override via `LOTL_LMSTUDIO_GEN_MODEL`)
- **Judge:** `qwen/qwen3.6-35b-a3b` Q4_K_M (override via `LOTL_LMSTUDIO_JUDGE_MODEL`)
- **Alternative stack:** `google/gemma-4-e4b` (gen) + `google/gemma-4-26b-a4b` (judge) — 4–5 parallel judge slots fit, materially faster judge pass. See `evaluate/scripts/smoke-gemma-validate.sh`.

### The scripts, in order of typical use

| Script | Purpose | Wall |
|---|---|---|
| `evaluate/scripts/smoke-all-lmstudio.sh` | Baseline 4-pair smoke (LME v11, LME v14, LoCoMo v11 lenient, LoCoMo v14 strict). Parallel-aware. | ~50–90 min |
| `evaluate/scripts/smoke-resume-full.sh` | Mid-flight resume after a kill. Replays cached predictions, fresh-gens the rest. | ~20–30 min |
| `evaluate/scripts/smoke-resume-locomo.sh` | LoCoMo-only resume (pairs 3+4 only) | ~15 min |
| `evaluate/scripts/smoke-gemma-validate.sh` | Same 4 pairs with gemma-4 gen+judge, separate tags for A/B vs llama+qwen baseline | ~15 min |
| `evaluate/scripts/rejudge-failed.sh` | Re-run judge pass only on a prior tag after judge failures (ctx overflow, unparseable). Uses llm-cache for free gen replay. | 5–10 min |
| `evaluate/longmemeval/lmstudio-two-pass.sh` | LME-only two-pass (gen → swap → judge) | variable |
| `evaluate/locomo/lmstudio-two-pass.sh` | LoCoMo-only two-pass | variable |

### Gotchas locked in (learned the hard way 2026-04-19)

1. **`context_length` on `/api/v1/models/load` is TOTAL across parallel slots,
   not per-slot.** Per-slot ctx = `context_length / parallel`. Size it as
   `desired_per_slot × parallel`. v11 prompts fit in ~4k per slot, v14 CoT
   needs ~12k per slot (8k prompt + 2560 output). `ctx=16384 parallel=8`
   gives 2k per slot and throws "Context size has been exceeded" on every
   v14 question.
2. **Cross-model unload before load.** LM Studio does NOT auto-evict when
   you call `/api/v1/models/load` — it tries to load the new model on top
   of the existing one. qwen (22 GB) + llama (5 GB + kv) fits barely, but
   partial CPU fallback makes qwen unreliable with transient fetch-fails.
   Every `load_llama` must unload qwen first; `load_qwen` must unload llama.
3. **Single-instance guarantee.** Each `load_model` helper unloads `:2`..`:8`
   suffix variants first. Multiple loaded instances of the same model →
   bare-name request routes non-deterministically → transient fetch-fails.
4. **Never run two smoke scripts concurrently.** Each issues its own
   load/unload → cascading "Operation canceled" errors. Kill old runs first.
5. **Workers must match `parallel`.** `LOTL_LME_WORKERS` /
   `LOTL_LOCOMO_WORKERS` = the parallel slot count loaded. Client-side
   concurrency is what fills the slots; llama.cpp batches forward passes
   across active slots.
6. **Thinking models need bigger judge token budget.** qwen3.6 burns ~150
   reasoning tokens before emitting the JSON verdict. Judge `max_tokens`
   bumps to 768 automatically when `--judge lmstudio`. Gemma doesn't think,
   so 96 tokens is enough if you switch.
7. **qwen ctx=32768 for judge of long v14 CoT predictions.** Extracted
   v14 answers can push judge input past 16k (we hit `n_keep=18904 > 16384`).
   All scripts default to 32k now.
8. **llm-cache survives kills.** `evaluate/{longmemeval,locomo}/llm-cache.json`
   persists every successful `askLLM` call keyed by `{model, prompt, seed,
   temperature}`. A re-run at the same seed hits the cache for every prior
   success; only new questions cost GPU time. Used by `smoke-resume-full.sh`
   and `rejudge-failed.sh`.

### VRAM budget (3090, 24 GB)

| Model | Weights | kv/slot (tokens × ~131 KB GQA) | Suggested config |
|---|---|---|---|
| llama-3.1-8B Q4_K_M | 4.92 GB | 4096t × 131 KB ≈ 0.54 GB | parallel=16, ctx=65536 (v11) |
| " | " | 12288t × 131 KB ≈ 1.61 GB | parallel=8, ctx=98304 (v14 CoT) |
| qwen3.6-35B-a3b Q4_K_M | 22.07 GB | 16384t × 131 KB ≈ 2.15 GB | parallel=1, ctx=32768 (solo) |
| gemma-4-26b-a4b Q4_K_M | ~17 GB | 16384t × 131 KB ≈ 1.54 GB | parallel=4, ctx=65536 (faster judge) |
| gemma-4-e4b Q4_K_M | ~3 GB | 4096t × ~80 KB ≈ 0.33 GB | parallel=16, ctx=65536 (v11) |

Never hold two heavy models concurrent — swap between them at each pair
boundary.

### Typical commands

```sh
# First-time baseline (all 4 pairs):
bash evaluate/scripts/smoke-all-lmstudio.sh

# Resume after kill (cache hits for completed q's):
bash evaluate/scripts/smoke-resume-full.sh

# Single-benchmark runs:
LOTL_LME_LIMIT=100 bash evaluate/longmemeval/lmstudio-two-pass.sh
LOTL_LOCOMO_LIMIT=10 bash evaluate/locomo/lmstudio-two-pass.sh

# A/B against gemma stack (runs after llama+qwen baseline lands):
bash evaluate/scripts/smoke-gemma-validate.sh

# Rejudge after ctx overflow / unparseable verdicts:
bash evaluate/scripts/rejudge-failed.sh locomo smoke-v14-strict --rules v14 --judge strict
```

Override sizing per prompt version:
```sh
LOTL_LMSTUDIO_CTX_V11=81920 LOTL_LMSTUDIO_PARALLEL_V11=20 \
LOTL_LMSTUDIO_CTX_V14=131072 LOTL_LMSTUDIO_PARALLEL_V14=8 \
  bash evaluate/scripts/smoke-all-lmstudio.sh
```

### Prompt versions (both benchmarks)

- **v11** (default) — rule-list + "Short answer:" constraint. Baseline since
  2026-04-16. Lower ceiling on LLM-judge because unconstrained-length
  systems score ~10pp higher per the locomo-audit methodology.
- **v13** (LME only) — minimal, no rules, recommended for Gemini-judge runs
  where rule lists constrain phrasing. Use via `LOTL_PROMPT_RULES=v13`.
- **v14** — audit's 7-step CoT, ported from dial481/locomo-audit
  `answer_prompt_cot`. No word limit. Output extracted via `extractFinalAnswer()`
  that strips the scaffold (gold tokens leak through STEP 2 / STEP 6 otherwise).
  Full-context baseline in the audit lifted 81.95% → 92.62% with this
  prompt alone. `LOTL_PROMPT_RULES=v14`.

### LoCoMo judge modes

LoCoMo defaults to **lenient** judge ("touches on topic = CORRECT") for
back-compat with prior Gemini-judge numbers. The audit identified this as
producing a 6.9× leniency ratio (62.8% of vague-but-topical wrong answers
scored CORRECT). Switch to the audit-corrected strict judge via
`LOTL_LOCOMO_JUDGE=strict` — same prompt shape as the LME judge, keeps
temporal format leniency ("May 7th" vs "7 May" still CORRECT).

LME judge is already strict (no leniency bug there).

### Interpreting smoke results

Files saved at `evaluate/{longmemeval,locomo}/results-smoke-<tag>-pass{1,2}.json`:
- pass1 = gen, pass2 = judge. pass2's `Judge` field is the binary LLM-as-judge
  accuracy; pass1 has F1/EM/R@K retrieval numbers.
- Small n (20 LME, 50 LoCoMo) is for wiring validation, not publishable
  numbers. For real signal, scale to LME n=500 / LoCoMo `--limit 20`
  (~200 questions) in Phase B.

## When to NOT run a sweep

- Without `LOTL_RECALL_NO_TOUCH=on`. Every number will be cross-contaminated.
- On a DB whose embedder doesn't match the current config's
  `LOTL_EMBED_MODEL`. Dimension mismatch crashes or silently reads stale
  vectors.
- While another sweep is running in the same directory tree — SQLite WAL
  contention + shared-cache gotchas. Use separate sweep dirs via `--name`.
- If you haven't updated `.graphifyignore` / `.gitignore` to keep tool
  artifacts out of the tarball (caught `src/graphify-out/` leaking 27
  files in tonight's npm pack audit).

## Session-specific results index

The canonical reference for each sweep run lives in `devnotes/sessions/` +
`devnotes/metrics/`:

- `devnotes/sessions/session-2026-04-19-overnight-sweeps.md` — tonight's master
- `devnotes/sessions/session-2026-04-19-morning-triage.md` — tomorrow's reading
- `devnotes/metrics/flag-sweep-phase1-2026-04-18.md` — first flag sweep
- `devnotes/architecture/phase5-kg-and-fact-aug-design.md` — future work
- `evaluate/SNAPSHOTS.md` — pinned v1 release numbers (the ones we cite
  externally)
