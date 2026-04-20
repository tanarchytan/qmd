/**
 * Smoke tests for src/llm/lmstudio-embed.ts.
 *
 * LM Studio's /v1/embeddings IS OpenAI-compatible (unlike rerank), so these
 * tests cover the batching + error-path behavior:
 *
 *   - single batch fits in one request
 *   - multiple batches stitch together preserving order
 *   - empty input returns [] without hitting the network
 *   - 400 on model-not-found throws with status in message
 *   - missing data array throws with explanatory message
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { lmStudioEmbed } from "../src/llm/lmstudio-embed.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockEmbedBatch(vectors: number[][]) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((v) => ({ embedding: v })) }),
    text: async () => "",
  }) as unknown as Response) as unknown as typeof fetch;
}

describe("lmstudio-embed batching + errors", () => {
  test("empty input returns [] without network call", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const r = await lmStudioEmbed([]);
    expect(r).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("single-batch input produces vectors in input order", async () => {
    mockEmbedBatch([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    const r = await lmStudioEmbed(["alpha", "beta"], { batchSize: 32 });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual([0.1, 0.2, 0.3]);
    expect(r[1]).toEqual([0.4, 0.5, 0.6]);
  });

  test("multi-batch stitches output in correct order across requests", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      const vectors = call === 1
        ? [[1, 1], [2, 2]]   // first batch
        : [[3, 3]];            // second batch
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: vectors.map((v) => ({ embedding: v })) }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await lmStudioEmbed(["a", "b", "c"], { batchSize: 2 });
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual([1, 1]);
    expect(r[1]).toEqual([2, 2]);
    expect(r[2]).toEqual([3, 3]);
    expect(call).toBe(2);
  });

  test("400 from LM Studio throws with status code in message", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error": "model not found"}',
      json: async () => ({ error: "model not found" }),
    }) as unknown as Response) as unknown as typeof fetch;
    await expect(lmStudioEmbed(["alpha"])).rejects.toThrow(/400/);
  });

  test("missing data array in response throws with explanatory message", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ /* no data */ }),
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
    await expect(lmStudioEmbed(["alpha"])).rejects.toThrow(/missing data array/);
  });

  test("model override via options takes priority over env var", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.9] }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    process.env.LOTL_LMSTUDIO_EMBED_MODEL = "env-model";
    await lmStudioEmbed(["alpha"], { model: "explicit-model" });
    expect(capturedBody?.model).toBe("explicit-model");
    delete process.env.LOTL_LMSTUDIO_EMBED_MODEL;
  });
});
