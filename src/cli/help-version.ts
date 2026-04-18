/**
 * cli/help-version.ts — `lotl --help` and `lotl --version` implementations.
 *
 * Extracted from cli/lotl.ts. Kept as one small module because they're both
 * dispatcher-leaf commands with no shared state beyond reading package.json
 * and the active DB path.
 */

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { readFileSync } from "fs";
import { resolve } from "../store.js";
import { getDbPath } from "./db-state.js";

export function showHelp(): void {
  console.log("lotl — Living-off-the-Land memory for AI agents");
  console.log("");
  console.log("Usage:");
  console.log("  lotl <command> [options]");
  console.log("");
  console.log("Primary commands:");
  console.log("  lotl query <query>             - Hybrid search with auto expansion + reranking (recommended)");
  console.log("  lotl query 'lex:..\\nvec:...'   - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  lotl search <query>            - Full-text BM25 keywords (no LLM)");
  console.log("  lotl vsearch <query>           - Vector similarity only");
  console.log("  lotl get <file>[:line] [-l N]  - Show a single document, optional line slice");
  console.log("  lotl multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  lotl skill show/install        - Show or install the packaged Lotl skill");
  console.log("  lotl mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  lotl bench <fixture.json>      - Run search quality benchmarks against a fixture file");
  console.log("");
  console.log("Collections & context:");
  console.log("  lotl collection add/list/remove/rename/show   - Manage indexed folders");
  console.log("  lotl context add/list/rm                      - Attach human-written summaries");
  console.log("  lotl ls [collection[/path]]                   - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("  lotl status                    - View index + collection health");
  console.log("  lotl update [--pull]           - Re-index collections (optionally git pull first)");
  console.log("  lotl embed [-f]                - Generate/refresh vector embeddings");
  console.log("    --max-docs-per-batch <n>    - Cap docs loaded into memory per embedding batch");
  console.log("    --max-batch-mb <n>          - Cap UTF-8 MB loaded into memory per embedding batch");
  console.log("  lotl cleanup                   - Clear caches, vacuum DB");
  console.log("");
  console.log("Query syntax (lotl query):");
  console.log("  Lotl queries are either a single expand query (no prefix) or a multi-line");
  console.log("  document where every line is typed with lex:, vec:, or hyde:. This grammar");
  console.log("  matches the docs in docs/SYNTAX.md and is enforced in the CLI.");
  console.log("");
  const grammar = [
    `query          = expand_query | query_document ;`,
    `expand_query   = text | explicit_expand ;`,
    `explicit_expand= "expand:" text ;`,
    `query_document = [ intent_line ] { typed_line } ;`,
    `intent_line    = "intent:" text newline ;`,
    `typed_line     = type ":" text newline ;`,
    `type           = "lex" | "vec" | "hyde" ;`,
    `text           = quoted_phrase | plain_text ;`,
    `quoted_phrase  = '"' { character } '"' ;`,
    `plain_text     = { character } ;`,
    `newline        = "\\n" ;`,
  ];
  console.log("  Grammar:");
  for (const line of grammar) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log("  Examples:");
  console.log("    lotl query \"how does auth work\"                # single-line → implicit expand");
  console.log("    lotl query $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    lotl query $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    lotl query $'hyde: Hypothetical answer text'       # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `lotl mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - `lotl skill install` installs the Lotl skill into ./.agents/skills/lotl.");
  console.log("  - Use `lotl skill install --global` for ~/.agents/skills/lotl.");
  console.log("  - `lotl --skill` is kept as an alias for `lotl skill show`.");
  console.log("  - Advanced: `lotl mcp --http ...` and `lotl mcp --http --daemon` are optional for custom transports.");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  LOTL_EDITOR_URI             - Editor link template for clickable TTY search output");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Max results (default 5, or 20 for --files/--json)");
  console.log("  --all                      - Return all matches (pair with --min-score)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  -C, --candidate-limit <n>  - Max candidates to rerank (default 40, lower = faster)");
  console.log("  --no-rerank                - Skip LLM reranking (use RRF scores only, much faster on CPU)");
  console.log("  --line-numbers             - Include line numbers in output");
  console.log("  --explain                  - Include retrieval score traces (query --json/CLI)");
  console.log("  --explain-json             - Shortcut for --json --explain (full structured trace)");
  console.log("  --files | --json | --csv | --md | --xml  - Output format");
  console.log("  -c, --collection <name>    - Filter by one or more collections");
  console.log("");
  console.log("Embed/query options:");
  console.log("  --chunk-strategy <auto|regex> - Chunking mode (default: regex; auto uses AST for code files)");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default 10240)");
  console.log("  --json/--csv/--md/--xml/--files - Same formats as search");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}

export async function showVersion(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(scriptDir, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  let commit = "";
  try {
    commit = execSync(`git -C ${scriptDir} rev-parse --short HEAD`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // Not a git repo or git not available.
  }

  const versionStr = commit ? `${pkg.version} (${commit})` : pkg.version;
  console.log(`lotl ${versionStr}`);
}
