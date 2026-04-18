/**
 * llm/session.ts — LLM session lifecycle management.
 *
 * Split out from src/llm.ts. Provides scoped sessions over any LLM
 * implementation (LlamaCpp or RemoteLLM) with:
 *   - Reference-counted active-session tracking
 *   - In-flight operation counting (so idle unload only fires when safe)
 *   - Per-session AbortController with optional max duration
 *   - Automatic release on callback completion via withLLMSessionForLlm
 *
 * Typed against the abstract LLM interface (types.ts) — no direct dependency
 * on LlamaCpp, so the plugin path that only uses RemoteLLM can also wrap
 * calls in sessions if needed.
 *
 * Note: the `getSessionManager()` / `withLLMSession()` / `canUnloadLLM()`
 * variants that bind to the *default* LlamaCpp singleton stay in src/llm.ts
 * because they reference the LlamaCpp-specific singleton. Only the
 * generic-over-LLM parts live here.
 */

import type {
  LLM,
  ILLMSession,
  LLMSessionOptions,
  EmbedOptions,
  EmbeddingResult,
  Queryable,
  RerankDocument,
  RerankOptions,
  RerankResult,
} from "./types.js";

/**
 * Manages LLM session lifecycle with reference counting.
 * Coordinates with LlamaCpp idle timeout to prevent disposal during active sessions.
 */
export class LLMSessionManager {
  private llm: LLM;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  /**
   * Returns true only when both session count and in-flight operations are 0.
   * Used by LlamaCpp to determine if idle unload is safe.
   */
  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlm(): LLM {
    return this.llm;
  }
}

/**
 * Error thrown when an operation is attempted on a released or aborted session.
 */
export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

/**
 * Scoped LLM session with automatic lifecycle management.
 * Wraps LLM methods with operation tracking and abort handling.
 */
export class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => {
          this.abortController.abort(options.signal!.reason);
        }, { once: true });
      }
    }

    // Set up max duration timer
    const maxDuration = options.maxDuration ?? 10 * 60 * 1000; // Default 10 minutes
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`));
      }, maxDuration);
      this.maxDurationTimer.unref(); // Don't keep process alive
    }

    // Acquire session lease
    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Release the session and decrement ref count.
   * Called automatically by withLLMSession when the callback completes.
   */
  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  /**
   * Wrap an operation with tracking and abort checking.
   */
  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      // Check abort before starting
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(
          this.abortController.signal.reason?.message || "Session aborted"
        );
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withOperation(() => this.manager.getLlm().embed(text, options));
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() => this.manager.getLlm().embedBatch(texts, options));
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    return this.withOperation(() => this.manager.getLlm().expandQuery(query, options));
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions
  ): Promise<RerankResult> {
    return this.withOperation(() => this.manager.getLlm().rerank(query, documents, options));
  }
}

/**
 * Execute a function with a scoped LLM session using a specific LLM instance.
 * Unlike withLLMSession (which uses the default singleton), this creates a
 * fresh manager for the provided LLM.
 */
export async function withLLMSessionForLlm<T>(
  llm: LLM,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = new LLMSessionManager(llm);
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}
