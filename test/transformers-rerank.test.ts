/**
 * transformers-rerank.test.ts — regression test for the local cross-encoder
 * rerank backend.
 *
 * Why this test exists: the original implementation (commit 773b079) called
 * the model via `pipeline("text-classification")`, which applies a softmax
 * over the model's class labels. cross-encoder/ms-marco-MiniLM-L6-v2 has a
 * single output neuron, so softmax over one class always = 1.0 — every
 * rerank score collapsed to 1.0 and the rerank was a perfect no-op on rank
 * order. The bug went undetected for several days of cross-bench runs
 * because the rerank pass technically "ran" without throwing; nothing
 * tested that the scores actually discriminate.
 *
 * This test asserts:
 *   1. The backend loads without throwing.
 *   2. Returned scores discriminate between obviously relevant and
 *      obviously irrelevant documents — concretely, the relevant doc must
 *      score AT LEAST 5 logit-units above the irrelevant doc.
 *   3. The relevant doc beats the irrelevant doc on rank order.
 *
 * If a future change re-introduces the softmax-over-single-class collapse,
 * the score discrimination will fail and this test will catch it instantly.
 *
 * The test downloads ~23 MB of model weights on first run (cached under
 * ~/.cache/qmd/transformers/) and is gated behind QMD_RUN_TRANSFORMERS_TEST
 * to keep CI from pulling the model on every PR. Run locally with:
 *
 *   QMD_RUN_TRANSFORMERS_TEST=1 npx vitest run test/transformers-rerank.test.ts
 */

import { describe, test, expect } from "vitest";
import { createTransformersRerankBackend } from "../src/llm/transformers-rerank.js";

const skipUnlessOptedIn = process.env.QMD_RUN_TRANSFORMERS_TEST !== "1";

describe.skipIf(skipUnlessOptedIn)("TransformersRerankBackend", () => {
  test("returns discriminative scores from the raw cross-encoder logits", async () => {
    const backend = await createTransformersRerankBackend();
    const docs = [
      { file: "relevant", text: "cats are small carnivorous mammals kept as household pets" },
      { file: "irrelevant", text: "mountains are tall geological formations made of rock" },
      { file: "weak", text: "feline pets are popular companion animals especially indoors" },
      { file: "noise", text: "the apple is on the table next to the laptop" },
    ];
    const result = await backend.rerank("what are cats", docs);

    // Backend echoes back the input order; all 4 docs scored.
    expect(result.results).toHaveLength(4);
    expect(result.results.map(r => r.file)).toEqual(["relevant", "irrelevant", "weak", "noise"]);

    const byFile = new Map(result.results.map(r => [r.file, r.score]));
    const relevantScore = byFile.get("relevant")!;
    const irrelevantScore = byFile.get("irrelevant")!;
    const noiseScore = byFile.get("noise")!;

    // Discrimination: the relevant doc must beat the irrelevant doc by a
    // wide margin. If this fails, the rerank pass is producing constant
    // or near-constant scores (the original bug). 5 logit-units is the
    // floor; observed gap on the verified backend is ~20.
    expect(relevantScore - irrelevantScore).toBeGreaterThan(5);
    expect(relevantScore - noiseScore).toBeGreaterThan(5);

    // Rank order: sort descending by score and assert the relevant doc
    // is at rank 1.
    const ranked = [...result.results].sort((a, b) => b.score - a.score);
    expect(ranked[0]!.file).toBe("relevant");
  }, 60_000);

  test("handles empty document list cleanly", async () => {
    const backend = await createTransformersRerankBackend();
    const result = await backend.rerank("anything", []);
    expect(result.results).toEqual([]);
  });
});
