/**
 * LM Studio rerank backend — routes rerank through LM Studio's
 * /v1/chat/completions with a scoring prompt. Unlocks GPU-accelerated
 * rerank at the cost of LLM-extracted scores (vs true cross-encoder
 * logits from transformers-rerank.ts).
 *
 * Why chat-completions and not /v1/rerank? LM Studio (as of 2026-04-20)
 * doesn't expose a rerank endpoint — its bundled `qwen3-reranker-0.6b`
 * is registered as `type=llm` and only reachable via chat. So we emit
 * a scoring prompt, parse a 0-1 score from the response, and treat it
 * as the rerank score.
 *
 * Activate via `LOTL_RERANK_BACKEND=lmstudio`. Model selection follows
 * the standard LM Studio pattern:
 *   LOTL_LMSTUDIO_HOST        10.0.0.113:1234
 *   LOTL_LMSTUDIO_RERANK_MODEL qwen3-reranker-0.6b  (or any small chat model)
 *
 * Because this is LLM-based not logit-based, expect noisier scores.
 * Use for GGUF-only rerankers or when the CPU transformers path is
 * too slow. For production A/B, prefer transformers-rerank.ts.
 */

import type { RerankDocumentResult, RerankResult } from "./types.js";

/** Tunable per-call so the rerank sweep can override. */
type LmStudioRerankOptions = {
  host?: string;
  model?: string;
  /** Response-format schema forces a numeric score. Default on. */
  structured?: boolean;
  /** Parallel workers — LM Studio handles batching server-side via `parallel` slots. */
  concurrency?: number;
  /** Max tokens for the judge response. 32 is plenty for a single number. */
  maxTokens?: number;
};

const RERANK_PROMPT = (query: string, doc: string): string =>
  `You are a relevance grader. Score how relevant the document is to the query on a 0-1 scale.

- 0.0 = completely unrelated
- 0.5 = tangentially related
- 1.0 = directly answers the query

Respond with a JSON object only: {"score": <number 0-1>}.

QUERY: ${query.trim().slice(0, 500)}

DOCUMENT: ${doc.trim().slice(0, 2000)}

SCORE:`;

const RERANK_RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "relevance_score",
    strict: true,
    schema: {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
      additionalProperties: false,
    },
  },
};

async function scoreOne(
  query: string,
  doc: string,
  opts: Required<Pick<LmStudioRerankOptions, "host" | "model" | "maxTokens" | "structured">>,
): Promise<number> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: "user", content: RERANK_PROMPT(query, doc) }],
    temperature: 0,
    seed: 42,
    max_tokens: opts.maxTokens,
  };
  // Thinking-model control: qwen3-reranker routes structured output into
  // message.reasoning_content instead of content (caught 2026-04-21 on
  // qwen-35b judge and confirmed to affect this rerank shim too). Disable
  // thinking so the score lands in content.
  if (opts.model && /qwen3/i.test(opts.model)) body.enable_thinking = false;
  if (opts.structured) body.response_format = RERANK_RESPONSE_SCHEMA;

  const resp = await fetch(`http://${opts.host}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LOTL_LMSTUDIO_KEY || "lm-studio"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`lmstudio rerank ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  // Defense-in-depth fallback: even with enable_thinking=false, some thinking
  // models still leak the structured output into reasoning_content.
  const msg = data.choices?.[0]?.message;
  const raw = (msg?.content && msg.content.length > 0) ? msg.content : (msg?.reasoning_content || "");
  // Parse JSON-schema-enforced {"score": ...} or fall back to first numeric match.
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (typeof obj.score === "number") return Math.max(0, Math.min(1, obj.score));
    } catch { /* fall through */ }
  }
  const numMatch = raw.match(/(0?\.\d+|1\.0|1|0)/);
  if (numMatch) return Math.max(0, Math.min(1, Number(numMatch[1])));
  // Unparseable → 0 (low signal, won't shadow a well-scored doc).
  process.stderr.write(`[lmstudio-rerank] unparseable: ${raw.slice(0, 80)}\n`);
  return 0;
}

export async function lmStudioRerank(
  query: string,
  docs: Array<{ file: string; text: string }>,
  options: LmStudioRerankOptions = {},
): Promise<RerankResult> {
  const host = options.host || process.env.LOTL_LMSTUDIO_HOST || "10.0.0.113:1234";
  const model = options.model || process.env.LOTL_LMSTUDIO_RERANK_MODEL || "qwen3-reranker-0.6b";
  const structured = options.structured ?? true;
  const maxTokens = options.maxTokens ?? 64;
  const concurrency = options.concurrency ?? Number(process.env.LOTL_LMSTUDIO_RERANK_WORKERS ?? 4);

  const opts = { host, model, maxTokens, structured };
  const scores: number[] = new Array(docs.length).fill(0);

  // Simple worker pool — N concurrent scoring calls, each one doc.
  let cursor = 0;
  const worker = async () => {
    while (cursor < docs.length) {
      const i = cursor++;
      if (i >= docs.length) break;
      const d = docs[i];
      if (!d) continue;
      try {
        scores[i] = await scoreOne(query, d.text, opts);
      } catch (err) {
        process.stderr.write(`[lmstudio-rerank] doc ${i} failed: ${err instanceof Error ? err.message : err}\n`);
        scores[i] = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, docs.length) }, () => worker()));

  const results: RerankDocumentResult[] = docs.map((d, i) => ({
    file: d.file,
    score: scores[i] ?? 0,
    index: i,
  }));
  return { results, model };
}
