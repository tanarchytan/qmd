/**
 * Phase 7: LLM-as-judge QA accuracy evaluation.
 *
 * Calls an OpenAI-compatible /v1/chat/completions endpoint (Poe, OpenAI, Together,
 * SiliconFlow, anyone who speaks that shape) with a structured "is this answer
 * correct?" prompt. Returns a {correct, reason} verdict.
 *
 * Usage — programmatic:
 *   import { judgeAnswer } from "./poe-judge.ts";
 *   const v = await judgeAnswer({ question, predicted, gold });
 *   console.log(v.correct, v.reason);
 *
 * Usage — CLI (for quick validation after activating Poe subscription):
 *   POE_API_KEY=sk-poe-... \
 *   npx tsx evaluate/longmemeval/poe-judge.mts \
 *     --question "Where did Alice grow up?" \
 *     --predicted "Alice grew up in Portland." \
 *     --gold "Portland, Oregon"
 *
 * Env:
 *   QMD_JUDGE_URL            (default https://api.poe.com/v1)
 *   QMD_JUDGE_API_KEY        (falls back to POE_API_KEY)
 *   QMD_JUDGE_MODEL          (default gpt-4o)
 *   QMD_JUDGE_TEMPERATURE    (default 0)
 *   QMD_JUDGE_MAX_TOKENS     (default 128)
 *   QMD_JUDGE_TIMEOUT_MS     (default 30000)
 */

export interface JudgeInput {
  question: string;
  predicted: string;
  gold: string;
  /** Optional context (retrieved memories, reference passages) shown to the judge. */
  context?: string;
}

export interface JudgeVerdict {
  correct: boolean;
  reason: string;
  raw: string;
  model: string;
  latencyMs: number;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a strict but fair grader. Given a question, a gold-standard answer, and a candidate answer, decide whether the candidate answer is factually equivalent to the gold answer. " +
  "A candidate answer is CORRECT if it expresses the same facts as the gold answer, even if the wording differs, entities are referenced by alias, or extra supporting detail is added. " +
  "A candidate answer is INCORRECT if it is missing any required fact, adds a contradictory fact, or if the stated fact has a different value than the gold answer. " +
  "Reply with a single JSON object on one line: {\"correct\": true|false, \"reason\": \"<one short sentence>\"}";

function buildUserMessage(input: JudgeInput): string {
  const parts = [
    `QUESTION: ${input.question.trim()}`,
    `GOLD ANSWER: ${input.gold.trim()}`,
    `CANDIDATE ANSWER: ${input.predicted.trim()}`,
  ];
  if (input.context) parts.push(`CONTEXT (may be incomplete): ${input.context.trim()}`);
  parts.push("Respond with the JSON object only.");
  return parts.join("\n\n");
}

export async function judgeAnswer(input: JudgeInput): Promise<JudgeVerdict> {
  const url = (process.env.QMD_JUDGE_URL || "https://api.poe.com/v1").replace(/\/$/, "");
  const apiKey = process.env.QMD_JUDGE_API_KEY || process.env.POE_API_KEY;
  if (!apiKey) throw new Error("QMD_JUDGE_API_KEY or POE_API_KEY must be set");
  const model = process.env.QMD_JUDGE_MODEL || "gpt-4o";
  const temperature = Number(process.env.QMD_JUDGE_TEMPERATURE ?? 0);
  const maxTokens = Number(process.env.QMD_JUDGE_MAX_TOKENS ?? 64);
  const timeoutMs = Number(process.env.QMD_JUDGE_TIMEOUT_MS ?? 30000);

  const body = {
    model,
    messages: [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(input) },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const raw = String(json.choices?.[0]?.message?.content ?? "").trim();
    // Tolerate the model wrapping the JSON in prose or fences.
    const match = raw.match(/\{[\s\S]*?\}/);
    const obj = match ? JSON.parse(match[0]) : { correct: false, reason: "could not parse verdict" };
    return {
      correct: Boolean(obj.correct),
      reason: String(obj.reason ?? "").slice(0, 400),
      raw,
      model,
      latencyMs,
    };
  } finally {
    clearTimeout(t);
  }
}

// CLI: kept tiny. Only runs when this file is invoked directly.
if (import.meta.url.startsWith("file://") && process.argv[1] && process.argv[1].endsWith("poe-judge.mts")) {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i]?.replace(/^--/, "");
    if (k && process.argv[i + 1]) args.set(k, process.argv[i + 1]!);
  }
  const question = args.get("question") ?? "What is the capital of France?";
  const predicted = args.get("predicted") ?? "Paris.";
  const gold = args.get("gold") ?? "Paris";
  try {
    const v = await judgeAnswer({ question, predicted, gold });
    console.log(JSON.stringify(v, null, 2));
  } catch (err) {
    console.error("judge failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
