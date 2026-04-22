# Session — 2026-04-20 (LM Studio outage + non-LM recovery work)

Morning (~08:30 Amsterdam) resume was blocked mid-sweep by LM Studio host
going offline. Pivoted to non-LM-Studio work (ONNX rerank sweeps + docs).

## Fire-order executed

1. ✅ **Phase B gemma** fired — aborted mid-pass2 when LM Studio died.
   - `pass1.json` (LME gen) SAVED at 08:55 (494 KB, 500 rows).
   - `pass2.json` (judge pass) partial (38 KB, stopped at query 57/500 with
     `[judge] failed: fetch failed` on every attempt).
2. 🔴 **LM Studio host 10.0.0.105 unreachable** — 100% ping loss, not just
   `/v1/models` timeout. Whole machine off/asleep. User cannot physically
   reboot until tonight. Parked all LM Studio tasks.
3. ✅ **Non-LM sweeps fired** (running on localhost CPU):
   - `sweep-weight-jina-locomo` — 10 configs (9 ratios × jina-tiny + baseline)
     on LoCoMo-full. ETA 10–15 min.
   - `sweep-weight-jina-lme` — same grid on LME n=500. ETA ~10 min.
   - `sweep-big-rerankers-locomo` — mxbai-base-v1, gte-modernbert-base,
     tomaarsen/reranker-ModernBERT-base-gooaq-bce at 7/3 weights + baseline.
     ETA 12-24h CPU wall.
4. ✅ **Task list cleanup** — 10 stale completed tasks deleted.

## GGUF download pre-stage (complete from prior turn)

Via `POST /api/v1/models/download` with HF URLs; all 9 models downloaded
before the host died. LM Studio normalizes repo names to short canonical IDs
on registration — patched `rerank-lmstudio-gguf.txt` accordingly.

| Canonical ID | HF repo | Size | Role |
|---|---|---|---|
| `jina-reranker-v3` | `jinaai/jina-reranker-v3-GGUF` | 640 MB | BEIR #1 (61.94) |
| `mxbai-rerank-large-v2` | `mradermacher/mxbai-rerank-large-v2-GGUF` | 1.6 GB | BEIR #2 (61.44) |
| `qwen3-reranker-4b` | `QuantFactory/Qwen3-Reranker-4B-GGUF` | 2.6 GB | BEIR #3 (61.16) |
| `mxbai-rerank-base-v2` | `mradermacher/mxbai-rerank-base-v2-GGUF` | 531 MB | BEIR #5 (58.40) |
| `bge-reranker-v2-m3-GGUF` → `text-embedding-bge-reranker-v2-m3` | `gpustack/bge-reranker-v2-m3-GGUF` | 636 MB | BEIR 56.51 (quirk: LM Studio tagged as embed) |
| `qwen3-reranker-0.6b` | `Mungert/Qwen3-Reranker-0.6B-GGUF` | 639 MB | BEIR 56.28 |
| `jina-reranker-v1-tiny-en` | `gpustack/jina-reranker-v1-tiny-en-GGUF` | 37 MB | Stage 9 champion (sanity) |
| `gte-reranker-modernbert-base` | `keisuke-miyako/gte-reranker-modernbert-base-gguf-q8_0` | 161 MB | 149M comparator |
| `text-embedding-embeddinggemma-300m` | `ggml-org/embeddinggemma-300M-GGUF` | 329 MB | Google 300M embedder A/B |

## Risk flags

1. **jina-reranker-v3** — accepted the download but per `ggml-org/llama.cpp#17189`,
   the MLP projector needs a llama.cpp fork. Mainline LM Studio may reject or
   score noisily at runtime. Smoke-test first; skip and revisit if it fails.
2. **bge-reranker-v2-m3** was autodetected as embed-type by LM Studio. The
   chat-completions shim our `lmstudio-rerank.ts` uses may be refused. If so,
   manually reclassify in LM Studio UI (Settings → Model → Set as LLM).

## Parked tasks (require LM Studio, resume tonight)

- #33 Phase B gemma — resume from `pass1.json`; judge-only rerun (~15–20 min)
- #32 Phase B llama+qwen cross-stack
- #36 Phase C adversarial baseline (needs LLM gen)
- #38 Phase D combined-winners
- #52/#53 GGUF rerank sweeps

## Deferred (post-sweeps)

- #47 `LOTL_EVAL_*` prefix rename — 32 eval-only env vars identified. Too
  risky to rename while 3 sweeps run using LOTL_* names. Defer to after
  sweeps settle. Subagent scoping report saved inline.

## Docs updated this session

- `CHANGELOG.md` — LM Studio GPU backends + BEIR top-3 + embed-gemma entries
- `docs/ROADMAP.md` — 2026-04-20 session block (this)
- `docs/TODO.md` — status refresh, parked markers
- `evaluate/sweeps/configs/rerank-lmstudio-gguf.txt` — BEIR #3 Qwen3-4B added +
  canonical ID patch (all short-form IDs)

## Next session (tonight)

1. Confirm LM Studio host up: `curl http://10.0.0.113:1234/v1/models`
2. `bash evaluate/scripts/phase-b-gemma.sh` — re-fires from gen cache, judge only
3. `bash evaluate/scripts/phase-b-llama-qwen.sh` — cross-stack
4. `node evaluate/scripts/wilson-ci.mjs --compare <gemma> <llama-qwen>`
5. `bash evaluate/scripts/sweep-flags.sh evaluate/sweeps/configs/rerank-lmstudio-gguf.txt --corpus locomo --name beir-top3-gguf`
6. Combined-winners → #38 → Phase F release chain
