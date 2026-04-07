import {
  RemoteLLM,
  type ILLMSession,
  type Queryable,
  type RerankDocument,
} from "../../llm.js";
import type { LLMPort, ExpandOptions } from "../ports/llm.js";
import { createRemoteConfigFromEnv } from "../../remote-config.js";

export function createLLMService(): LLMPort {
  const remoteConfig = createRemoteConfigFromEnv();
  const remote = remoteConfig ? new RemoteLLM(remoteConfig) : null;

  type OpName = "embed" | "rerank" | "queryExpansion";
  const opHealth = new Map<OpName, { consecutiveFailures: number; cooldownUntilMs: number }>();
  const FAILURE_THRESHOLD = 3;
  const COOLDOWN_MS = 5 * 60 * 1000;

  const isCoolingDown = (op: OpName): boolean => {
    const state = opHealth.get(op);
    if (!state) return false;
    return Date.now() < state.cooldownUntilMs;
  };

  const recordSuccess = (op: OpName): void => { opHealth.delete(op); };

  const recordFailure = (op: OpName): void => {
    const now = Date.now();
    const state = opHealth.get(op);
    const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1;
    const isThreshold = consecutiveFailures >= FAILURE_THRESHOLD;
    const cooldownUntilMs = isThreshold ? now + COOLDOWN_MS : (state?.cooldownUntilMs ?? 0);
    opHealth.set(op, { consecutiveFailures: isThreshold ? 0 : consecutiveFailures, cooldownUntilMs });
  };

  const ensureRemote = (): RemoteLLM => {
    if (!remote) {
      throw new Error(
        "No remote LLM configured. Set QMD_EMBED_PROVIDER, QMD_RERANK_PROVIDER, or QMD_QUERY_EXPANSION_PROVIDER."
      );
    }
    return remote;
  };

  return {
    async withSession<T>(fn: (session?: ILLMSession) => Promise<T>, opts?: { maxDuration?: number; name?: string }): Promise<T> {
      void opts;
      return fn(undefined);
    },

    async expandQuery(query: string, options?: ExpandOptions, session?: ILLMSession): Promise<Queryable[]> {
      void session;
      const includeLexical = options?.includeLexical ?? true;
      const context = options?.context;
      void context;

      const lexicalFallback = (): Queryable[] => (includeLexical ? [{ type: "lex", text: query }] : []);

      if (!remote || !remoteConfig?.queryExpansion) {
        return lexicalFallback();
      }
      if (isCoolingDown("queryExpansion")) {
        return lexicalFallback();
      }

      try {
        const out = await remote.expandQuery(query, { includeLexical });
        recordSuccess("queryExpansion");
        return out;
      } catch (err) {
        recordFailure("queryExpansion");
        return lexicalFallback();
      }
    },

    async rerank(query: string, documents: RerankDocument[], session?: ILLMSession): Promise<{ file: string; score: number; extract?: string }[]> {
      void session;
      const llm = ensureRemote();

      if (!remoteConfig?.rerank) {
        throw new Error("Remote rerank not configured. Set QMD_RERANK_PROVIDER.");
      }
      if (isCoolingDown("rerank")) {
        throw new Error("Remote rerank is cooling down due to repeated failures. Please retry later.");
      }

      try {
        const result = await llm.rerank(query, documents);
        recordSuccess("rerank");
        return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
      } catch (err) {
        recordFailure("rerank");
        throw err;
      }
    },

    async embed(text: string, options?: { model?: string; isQuery?: boolean }, session?: ILLMSession): Promise<{ embedding: number[] }> {
      void session;
      const llm = ensureRemote();

      if (!remoteConfig?.embed) {
        throw new Error("Remote embed not configured. Set QMD_EMBED_PROVIDER.");
      }
      if (isCoolingDown("embed")) {
        throw new Error("Remote embed is cooling down due to repeated failures. Please retry later.");
      }

      try {
        const result = await llm.embed(text, options);
        if (!result) throw new Error("Remote embedding returned null");
        recordSuccess("embed");
        return result;
      } catch (err) {
        recordFailure("embed");
        throw err;
      }
    },
  };
}
