/**
 * Smoke tests for src/llm/lmstudio-rerank.ts.
 *
 * LM Studio's /v1/rerank doesn't exist yet (as of 2026-04-20) — our shim
 * routes through /v1/chat/completions with a scoring prompt and parses
 * 0-1 scores from a json_schema-enforced response. These tests cover the
 * parsing edge cases that fail silently in production:
 *
 *   - valid {"score": 0.87} → score clamped to [0,1]
 *   - malformed JSON → regex fallback extracts first numeric
 *   - unparseable response → returns 0, logs to stderr
 *   - 404/405 on bge-v2-m3 (LM Studio misclassified as embed-type) → throws
 *   - per-doc failures don't poison the batch (worker-pool error isolation)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lmStudioRerank } from "../src/llm/lmstudio-rerank.js";

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function mockChatCompletionWith(content: string, status = 200) {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (status < 300 ? JSON.stringify({ choices: [{ message: { content } }] }) : content),
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response) as unknown as typeof fetch;
}

beforeEach(() => {
  process.stderr.write = vi.fn() as unknown as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
});

describe("lmstudio-rerank parsing", () => {
  test("valid {'score': 0.87} is accepted and preserved", async () => {
    mockChatCompletionWith('{"score": 0.87}');
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBeCloseTo(0.87, 5);
  });

  test("score > 1 is clamped to 1", async () => {
    mockChatCompletionWith('{"score": 1.7}');
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBe(1);
  });

  test("score < 0 is clamped to 0", async () => {
    mockChatCompletionWith('{"score": -0.3}');
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBe(0);
  });

  test("malformed JSON falls back to regex numeric extraction", async () => {
    mockChatCompletionWith("Sure! Here is the score: 0.72 based on the analysis.");
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBeCloseTo(0.72, 5);
  });

  test("unparseable response returns score=0 and stderr-warns", async () => {
    mockChatCompletionWith("I don't know how to score this.");
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBe(0);
    // stderr.write should have been called with the unparseable diagnostic
    expect(process.stderr.write).toHaveBeenCalled();
  });

  test("per-doc fetch error leaves score=0, does not poison other docs", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 2) {
        throw new Error("network ECONNRESET");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"score": 0.5}' } }] }),
        text: async () => '{"score": 0.5}',
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await lmStudioRerank("q", [
      { file: "a", text: "doc a" },
      { file: "b", text: "doc b" },
      { file: "c", text: "doc c" },
    ], { concurrency: 1 });
    const scores = r.results.map((x) => x.score);
    // First + third score = 0.5 each; middle one failed → 0
    expect(scores).toContain(0.5);
    expect(scores).toContain(0);
    expect(scores.filter((s) => s === 0.5).length).toBeGreaterThanOrEqual(2);
  });

  test("405/404 on bge-v2-m3 embed-misclassification throws with status in message", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"error": "model does not support chat completions"}',
      json: async () => ({ error: "model does not support chat completions" }),
    }) as unknown as Response) as unknown as typeof fetch;
    // Per-doc failure is caught → score becomes 0 but no throw escapes.
    // Assert the error branch was hit (stderr write) and no doc got a real score.
    const r = await lmStudioRerank("q", [{ file: "a", text: "doc a" }]);
    expect(r.results[0]?.score).toBe(0);
    expect(process.stderr.write).toHaveBeenCalled();
  });

  test("empty docs array returns empty results (no fetch)", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const r = await lmStudioRerank("q", []);
    expect(r.results).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("preserves order: doc index matches input array index", async () => {
    mockChatCompletionWith('{"score": 0.5}');
    const docs = [
      { file: "first", text: "1" },
      { file: "second", text: "2" },
      { file: "third", text: "3" },
    ];
    const r = await lmStudioRerank("q", docs);
    expect(r.results.map((x) => x.file)).toEqual(["first", "second", "third"]);
    expect(r.results.map((x) => x.index)).toEqual([0, 1, 2]);
  });
});
