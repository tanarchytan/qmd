/**
 * Minimal type declarations for openclaw/plugin-sdk.
 * The full types come from the openclaw package when installed.
 * These stubs let us compile without the optional peer dependency.
 *
 * Based on: https://docs.openclaw.ai/plugins/sdk-overview
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(opts: {
    id: string;
    name: string;
    description: string;
    kind?: "memory" | "context-engine";
    configSchema?: unknown;
    register: (api: import("openclaw/plugin-sdk").OpenClawPluginApi) => void;
  }): unknown;
}

declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    id: string;
    name: string;
    pluginConfig: unknown;
    logger: {
      debug: (msg: string) => void;
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    on: (event: string, handler: (...args: any[]) => void | Promise<void>) => void;
    registerHook: (events: string | string[], handler: (...args: any[]) => any, opts?: unknown) => void;
    registerTool: (tool: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }, opts?: { optional?: boolean }) => void;
    registerService: (opts: { id: string; start: () => void; stop: () => void }) => void;
    registerCli?: (registrar: (cmd: any) => void, opts?: unknown) => void;
    registerMemoryPromptSupplement?: (builder: unknown) => void;
    registerMemoryCorpusSupplement?: (adapter: unknown) => void;
    resolvePath: (input: string) => string;
  }
}
