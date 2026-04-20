/**
 * LM Studio embed backend — routes embeddings through LM Studio's
 * /v1/embeddings endpoint. Unlocks GPU-accelerated embeddings for
 * GGUF-only embedders (text-embedding-embeddinggemma-300m, etc.) that
 * don't have ONNX conversions for our transformers-embed.ts path.
 *
 * Activate via `LOTL_EMBED_BACKEND=lmstudio`. Model selection:
 *   LOTL_LMSTUDIO_HOST        10.0.0.105:1234
 *   LOTL_LMSTUDIO_EMBED_MODEL text-embedding-embeddinggemma-300m  (default)
 *
 * Unlike rerank, LM Studio's /v1/embeddings IS OpenAI-compatible and
 * returns proper vector responses. No prompt-based shim needed.
 */

type LmStudioEmbedOptions = {
  host?: string;
  model?: string;
  /** Batch size per request to LM Studio. Default 32 — most embedders handle 64+ fine. */
  batchSize?: number;
};

async function embedBatchOnce(
  texts: string[],
  host: string,
  model: string,
): Promise<number[][]> {
  const resp = await fetch(`http://${host}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LOTL_LMSTUDIO_KEY || "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!resp.ok) throw new Error(`lmstudio embed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as { data?: Array<{ embedding: number[] }> };
  if (!data.data || !Array.isArray(data.data)) throw new Error("lmstudio embed: missing data array");
  return data.data.map((d) => d.embedding);
}

export async function lmStudioEmbed(
  texts: string[],
  options: LmStudioEmbedOptions = {},
): Promise<number[][]> {
  const host = options.host || process.env.LOTL_LMSTUDIO_HOST || "10.0.0.105:1234";
  const model = options.model || process.env.LOTL_LMSTUDIO_EMBED_MODEL || "text-embedding-embeddinggemma-300m";
  const batchSize = options.batchSize ?? Number(process.env.LOTL_LMSTUDIO_EMBED_BATCH ?? 32);

  if (texts.length === 0) return [];
  const all: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, Math.min(i + batchSize, texts.length));
    const embs = await embedBatchOnce(batch, host, model);
    for (let j = 0; j < embs.length; j++) all[i + j] = embs[j] ?? [];
  }
  return all;
}
