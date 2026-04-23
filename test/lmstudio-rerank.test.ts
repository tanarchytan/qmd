/**
 * lmstudio-rerank.test.ts — smoke tests for the OpenAI-compatible (LLM
 * chat-based) rerank path in RemoteLLM.rerank().
 *
 * Covers three failure modes the v1.0.0 eval harness had to learn about
 * the hard way:
 *
 *   1. Qwen3 "thinking" model responses put structured output in
 *      `message.reasoning_content` instead of `message.content`. The eval
 *      harness was patched across 6 sites to fall back to
 *      `reasoning_content`; the production src/llm/remote.ts path was not.
 *      This test locks in the fallback so future Qwen-style models don't
 *      silently regress to empty reranks.
 *
 *   2. Upstream timeout — fetch hangs until AbortController kicks in.
 *      Must surface as an error, not a silent empty rerank.
 *
 *   3. Host unreachable — fetch rejects immediately (ECONNREFUSED style).
 *      Must surface as an error after retries.
 *
 * Tests mock globalThis.fetch; no network.
 */

import type { MockInstance } from "vitest";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { RemoteLLM } from "../src/llm/remote.js";
import type { RerankDocument } from "../src/llm/types.js";

const makeRerank = () => new RemoteLLM({
  rerank: {
    provider: "api",
    apiKey: "lm-studio",
    url: "http://10.0.0.116:1234/v1",
    model: "qwen/qwen3.6-35b-a3b",
    mode: "llm",
  },
});

const DOCS: RerankDocument[] = [
  { file: "a", text: "cats are small carnivorous mammals kept as household pets" },
  { file: "b", text: "mountains are tall geological formations" },
  { file: "c", text: "feline pets are popular companion animals" },
];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("RemoteLLM.rerank — LM Studio chat shim", () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("parses a normal response (content populated)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: "[0] cats are pets\n[2] feline pets are companion animals" } }],
    }));

    const result = await makeRerank().rerank("what are cats", DOCS, { timeoutMs: 1000 });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.file).toBe("a");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test("falls back to reasoning_content when content is empty (Qwen3 thinking-model pattern)", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: "",
          reasoning_content: "[0] cats are pets\n[2] feline pets are companion animals",
        },
      }],
    }));

    const result = await makeRerank().rerank("what are cats", DOCS, { timeoutMs: 1000 });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.file).toBe("a");
  });

  test("surfaces a timeout as an error (fetch hangs past timeoutMs)", async () => {
    fetchSpy.mockImplementation((_input, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    }));

    await expect(
      makeRerank().rerank("x", DOCS, { timeoutMs: 50 }),
    ).rejects.toThrow(/rerank/);
  }, 10_000);

  test("surfaces a host-unreachable error after retries (ECONNREFUSED style)", async () => {
    fetchSpy.mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

    await expect(
      makeRerank().rerank("x", DOCS, { timeoutMs: 100 }),
    ).rejects.toThrow(/rerank error/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 10_000);
});
