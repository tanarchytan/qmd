# Honest Hybrid LoCoMo Eval Harness

**Built 2026-04-18. Synthesis of competitor audit: snap-research (canonical), Mem0 (paper), MemPalace (controversy), Mastra (refusal), memory-lancedb-pro.**

## Competitor audit deltas

| System | top-k | Generator | Judge | Metrics | Known-cheat? |
|---|---|---|---|---|---|
| **snap-research** (canonical) | n/a (paper) | gpt-4 / claude / gemini | **none** (rule-based only) | F1 (stemmed-overlap), per-category | — |
| **Mem0** (arXiv:2504.19413) | 10 (paper) / 30 (code) | gpt-4o-mini | stronger LLM, "generous on topic" CORRECT/WRONG | F1 + BLEU-1 + LLM-Judge (J) | — |
| **MemPalace** (claim: 100%) | **50** (>session count) | — | — | Recall@K (retrieval-only) | **YES** — top_k ≥ sessions returns whole conv, bypasses retrieval |
| **Mastra** | — | — | — | — | **Deliberately refuses LoCoMo**: F1 penalizes correct+extra; judge prompts unstandardized |
| **memory-lancedb-pro** | — | — | — | — | Eval harness claimed "open source" but not visible in repo (`test/` dir has generic benchmark-runner.mjs, no LoCoMo files) |
| **Lotl (current)** | 10 | MiniMax / Gemini-2.5-flash | **none** yet for LoCoMo | F1 + EM + R@5 + R@10 | — |

## The honest synthesis

Blend the canonical methodology (F1-stemmed) with Mem0's judge (for semantic correctness) while avoiding MemPalace's whole-conv leak and Mastra's judge-inconsistency critique.

### Fixed rules

1. **top_k = 10** — Mem0 paper default. Avoids whole-conv leak (LoCoMo convs have up to 32 sessions; 10 forces real retrieval).
2. **Three metrics, all reported:**
   - **F1** stemmed-token-overlap, Porter stemmer, stopword removal (canonical snap-research)
   - **Judge-Acc** — binary CORRECT/WRONG via LLM-as-judge (Mem0-style, semantic ceiling)
   - **R@5 / R@10** — retrieval sanity (catches retrieval regressions the generator can hide)
3. **Generator = gpt-4o-mini** via Poe — Mem0's cheapest reproducible baseline. Pin model string.
4. **Judge = gpt-4o** via Poe — stronger than generator (Mem0's "more capable LLM"). Pin model string.
5. **Fixed seed = 42** everywhere (Gemini best-effort; Poe temp=0).
6. **Per-category breakdown** — single-hop / multi-hop / temporal / open-domain / adversarial. Average scores are dominated by multi-hop, so categories reveal real behavior.
7. **Disclosure** — log top_k alongside max session count per conv. Log judge prompt verbatim. Log dataset hash.
8. **Dataset** = snap-research `locomo10.json`, all 10 conversations at full length (not 20Q samples — those inflate ~20pp per memory note 2026-04-11).

### Judge prompt (verbatim, from Mem0 methodology)

```
You are a grader. You will be given a question, a gold answer, and a predicted answer.

Judge whether the predicted answer is CORRECT or WRONG.

Be generous: if the predicted answer touches the same topic/facts as the gold, mark CORRECT — even if phrasing, format, or length differ. Only mark WRONG if the predicted answer contradicts the gold, hallucinates, or fails to address the question.

For adversarial questions (where the gold is a refusal like "not mentioned"), mark CORRECT only if the prediction also refuses / says insufficient information.

Question: {question}
Gold answer: {gold}
Predicted answer: {pred}

Reply with exactly one word: CORRECT or WRONG.
```

### Anti-cheating checks

- Assert `top_k < max_sessions_in_conv` before every run; fail-loud if violated
- Log dataset SHA so cache poisoning is detectable
- Cache judge verdicts keyed by (question, gold, pred, judge-model) — identical triplets must get identical verdict

### No-API phase compatibility

For the local/CPU-only phases (Step 5 conv-26+30, Step 7 full LoCoMo vs winner+baseline), drop the LLM-judge and keep F1 + R@5 + R@10. Flag reported scores as "retrieval-only, no judge."

## Phased execution plan

| Step | Mode | Metrics | Cost |
|---|---|---|---|
| 5. conv-26 + conv-30 vs top-3 embedders | `--no-llm` | F1 + R@5 + R@10 | Local CPU |
| 7. Full LoCoMo (10 conv) vs winner + baseline | `--no-llm` | F1 + R@5 + R@10 per-category | Local CPU |
| 8. Full LongMemEval vs winner | `--no-llm` | rAny@5 + MRR | Local CPU |
| — Fact-augmented keys (Phase 6) — | | | Dev |
| 10. Full LME with judge vs Poe | `--llm poe --judge poe` | F1 + Judge-Acc | Poe pts |
| 11. Full LoCoMo with judge vs Poe | `--llm poe --judge poe` | F1 + Judge-Acc per-category | Poe pts |

If Poe balance runs out mid-run, fallback to `--llm gemini --judge gemini` with paid `GOOGLE_API_KEY` (instruction from user 2026-04-18).

## Wiring work required before steps 10/11

- Add `--judge poe|gemini` flag + `--judge-model <name>` to `evaluate/locomo/eval.mts` (mirror LongMemEval eval.mts plumbing from Phase 7)
- Port Mem0's verbatim judge prompt
- Add per-category aggregation to the results JSON output
- Cache judge verdicts in existing llm-cache.json

## References

- [snap-research/locomo](https://github.com/snap-research/locomo) — canonical paper + eval
- [Mem0 eval code](https://github.com/mem0ai/mem0/tree/main/evaluation) — run_experiments.py (top_k=30 default), prompts.py (answer gen), evals.py (F1+BLEU+Judge flow)
- [Mem0 paper arXiv:2504.19413](https://arxiv.org/html/2504.19413v1) — methodology spec
- [MemPalace benchmark issue #29](https://github.com/MemPalace/mempalace/issues/29) — whole-conv leak analysis
- [Mastra on LoCoMo](https://mastra.ai/research/observational-memory) — judge-inconsistency rationale
