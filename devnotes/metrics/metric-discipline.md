Let me walk through each one, what it's supposed to measure in the LongMemEval context, and where the common implementation mistakes are.

---

**R@K (Recall@K)**

In standard IR, Recall@K is the *fraction* of all relevant documents found in the top K results. If a question has 3 gold sessions and you find 2 of them in your top 5, that's R@5 = 0.667.

But LongMemEval implementations vary on this. MemPalace and several others use **recall_any@K**: did *at least one* gold session appear in the top K? That's a binary 0 or 1 per question. This is a much easier metric. With 3 gold sessions, finding just 1 scores 1.0.

The LongMemEval paper itself reports recall@K as fraction-based (standard IR), not binary. This matters a lot for multi-session questions which have 2-6 evidence sessions. If you're doing binary recall_any, your multi-session 85% means 15% of questions had *zero* gold sessions in top 5. If you're doing fractional recall, 85% means on average you're finding 85% of the evidence sessions, which is much better.

Check which one you're doing. If it's binary, your actual retrieval coverage is better than it looks.

**Correct calculation (standard, per the paper):**

```
For each question:
  gold_sessions = set of session IDs containing evidence
  retrieved_top_k = set of session IDs in your top K results
  recall = |gold_sessions ∩ retrieved_top_k| / |gold_sessions|

R@K = average across all questions
```

---

**MRR (Mean Reciprocal Rank)**

MRR measures where the *first* relevant result appears. If the first gold hit is at position 1, reciprocal rank = 1.0. Position 2 = 0.5. Position 3 = 0.333. Not found = 0.

```
For each question:
  scan results from position 1 to N
  find the first result whose session ID is in gold_sessions
  reciprocal_rank = 1 / position (or 0 if not found)

MRR = average across all questions
```

Your MRR of 0.833 means the first relevant hit is on average around position 1.2. That's good. But there's a subtle issue: for multi-session questions, MRR only tells you about the *first* evidence session found. If you need 3 sessions and the first one lands at position 1 but the other two are missing entirely, MRR still reports 1.0. MRR is blind to the coverage problem.

---

**NDCG@K (Normalized Discounted Cumulative Gain)**

This is the one most likely to be calculated wrong. NDCG accounts for both *relevance* and *position*. Higher-ranked relevant results contribute more to the score.

The tricky part: what's the relevance grade? In LongMemEval, the simplest approach is binary relevance (1 if it's a gold session, 0 if not). But some implementations weight by how many evidence snippets a session contains.

**Correct calculation (binary relevance):**

```
For each question:
  // DCG@K - what you actually got
  DCG = Σ (rel_i / log2(i + 1))  for i = 1 to K
  where rel_i = 1 if result at position i is a gold session, else 0

  // IDCG@K - the perfect ranking (all gold sessions at top)
  Sort gold sessions to the top positions
  IDCG = Σ (1 / log2(i + 1))  for i = 1 to min(K, |gold_sessions|)

  NDCG = DCG / IDCG

NDCG@K = average across all questions
```

The key mistake I'd watch for: **how you compute IDCG when a question has more relevant documents than K.** If a question has 4 gold sessions and K=10, the ideal puts all 4 at positions 1-4. If a question has 1 gold session and K=10, the ideal puts it at position 1. IDCG varies per question. If you're using a fixed IDCG across all questions, your NDCG will be wrong.

Your NDCG@10 of 0.828 versus MRR of 0.833 is interesting. Normally NDCG@10 should be somewhat close to MRR for single-relevant-document questions (where they measure nearly the same thing) but diverge for multi-relevant questions. The fact that they're almost identical suggests either your NDCG implementation is essentially doing MRR, or most of your questions only have one gold session. Multi-session questions have multiple, so if your NDCG@10 for multi-session (0.757) is close to MRR for multi-session (0.745), that could indicate you're only finding one gold session and the NDCG score is driven by where that single hit lands, not by coverage of multiple hits.

---

**F1 / EM / SH (Answer Quality)**

These are where you're almost certainly doing it differently from the leaderboard.

**EM (Exact Match):** Does the generated answer exactly match the gold answer string? Your 0% is expected if you're returning raw retrieved chunks rather than generating a short answer. Even generated answers rarely hit EM because the gold answers are short phrases and any extra word scores 0.

**F1 (Token F1):** Token overlap between prediction and gold answer. Compute precision (what fraction of predicted tokens appear in gold) and recall (what fraction of gold tokens appear in prediction), then harmonic mean. Your 6.1% confirms you're comparing retrieved chunk text against short gold answers. That will always be near-zero because the chunk contains hundreds of tokens and the gold answer is 2-5 tokens.

**SH (Substring Hit):** Does the gold answer appear as a substring anywhere in your output? More forgiving than EM. Your 13.8% means the literal gold answer string appears in your retrieved text about 14% of the time.

**What the leaderboard actually does:**

None of these three metrics are what published systems report. They all use **LLM-as-judge QA accuracy**. The flow is:

1. Retrieve your top-K results
2. Feed them to an LLM (gpt-4o is standard) with the question
3. The LLM generates a short answer
4. A second LLM call (or the same model) judges whether the generated answer is semantically correct against the gold answer
5. Score is binary correct/incorrect per question

The LongMemEval repo provides the exact evaluation script and judge prompt in `src/evaluation/evaluate_qa.py`. That produces the numbers you'd compare against Supermemory's 81.6%, Hindsight's 91.4%, etc.

---

**What I'd recommend checking in your implementation:**

1. Is your R@K binary (recall_any) or fractional? For multi-session questions this changes the number significantly.
2. Is your NDCG properly computing per-question IDCG based on the number of gold sessions for that specific question?
3. Are you deduplicating by session ID before computing metrics? If multiple retrieved chunks come from the same gold session, that's one hit, not multiple.
4. Are you excluding the 30 abstention questions from retrieval metrics? The LongMemEval paper explicitly skips them because they reference non-existing events and have no gold answer location.

R@K — There are two different things being called "Recall@K" and most implementations use the wrong one.
The LongMemEval paper (Wu et al., arxiv 2410.10813) defines Recall@K as fractional: what fraction of gold evidence sessions appear in your top K. This is standard IR recall. If a question has 3 gold sessions and you find 2 in top 5, score is 0.667.
MemPalace's benchmark code uses recall_any@K (binary): does at least one gold session appear in top K? Score is 0 or 1. The MemPalace issue #29 explicitly calls this out, noting that all of MemPalace's published numbers (96.6%, 98.4%, 100%) are recall_any@5, not the standard fractional recall the paper uses.
Agentmemory's benchmark docs are honest about this: they state their numbers are "retrieval recall scores" where they "check if gold session IDs appear in results." Their code likely uses recall_any too, based on the description.
What you should check: If you're doing recall_any (binary), your multi-session 85% means 15% of multi-session questions had zero gold sessions in top 5. That's a coverage failure. If you're doing fractional recall, 85% means you're finding 85% of the evidence on average, which is a much better position. The distinction changes your diagnosis entirely.
The paper's actual retrieval baselines in the appendix use fractional recall. If you want to be comparable to the paper, use fractional. If you want to be comparable to MemPalace/agentmemory, use recall_any.

NDCG@K — This is where I think your implementation might have an issue.
The standard NDCG calculation for multi-relevant-document queries:
DCG@K  = Σ (rel_i / log2(i + 1))  for i = 1..K
IDCG@K = Σ (1 / log2(i + 1))      for i = 1..min(K, |gold_sessions|)
NDCG   = DCG / IDCG
The critical detail: IDCG must be computed per-question based on that question's number of gold sessions. A single-session question with 1 gold session has IDCG = 1/log2(2) = 1.0. A multi-session question with 4 gold sessions has IDCG = 1/log2(2) + 1/log2(3) + 1/log2(4) + 1/log2(5) = 1.0 + 0.631 + 0.5 + 0.431 = 2.562.
MemPalace reports NDCG@10 of 0.889 for their raw mode. Your 0.828 is lower, but without knowing whether both implementations compute IDCG the same way, the comparison is unreliable.
The LongMemEval paper reports NDCG@K in their retrieval tables. They use binary relevance (gold session = 1, everything else = 0) and per-question IDCG normalization.
Common mistakes:

Using a fixed IDCG across all questions instead of per-question
Not accounting for the fact that multi-session questions have multiple gold documents (IDCG scales up)
Only counting the first gold hit (that's MRR, not NDCG)

Your NDCG@10 (0.828) being very close to your MRR (0.833) is a red flag. For single-evidence questions they should be similar, but for multi-session questions NDCG should diverge from MRR because NDCG rewards finding all gold sessions at good positions, while MRR only cares about the first one. If they're nearly identical overall, it suggests your NDCG might be effectively computing single-hit quality rather than multi-hit quality.

MRR — This one is straightforward and likely correct.
Every source agrees: 1/rank of the first relevant result, averaged across questions. The LongMemEval paper, Weaviate docs, agentmemory, Schift all use the same definition. Nothing to correct here.
One nuance: the paper skips the 30 abstention questions (they reference non-existing events, so there's no gold session to find). Make sure you're also skipping those, otherwise you're averaging in 30 questions that score 0.0 by design, which would drag MRR and all other metrics down. This affects n — the paper evaluates retrieval on 470 questions, not 500.

SR@K (Session Recall) — MemPalace-specific, not in the paper.
This is the recall_any metric applied at the session-ID level rather than the evidence-chunk level. Your SR@5 of 95.2% means at least one gold session ID appeared in your top 5 results for 95.2% of questions. This is what MemPalace calls their "R@5" but it's actually a different and easier metric than the paper's R@5.
Your SR@50 of 100% confirms that with enough depth your system always finds the gold session somewhere. The retrieval gap is entirely a ranking/coverage problem at shallow depths, not a fundamental failure to index the right content.

F1/EM/SH — These are irrelevant for retrieval-only evaluation.
Confirmed across all sources: nobody in the LME ecosystem uses token-level F1/EM for retrieval evaluation. These only make sense when you're comparing a generated answer against the gold answer string. Your 0% EM and 6.1% F1 are expected and correct for a system returning raw chunks instead of generated answers.
The leaderboard metric is LLM-as-judge QA accuracy — binary correct/incorrect scored by GPT-4o using the judge prompt provided in src/evaluation/evaluate_qa.py in the LongMemEval repo.
