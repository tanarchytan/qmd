/**
 * cli/help-version.ts — `qmd --help` and `qmd --version` implementations.
 *
 * Extracted from cli/qmd.ts. Kept as one small module because they're both
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
  console.log("qmd — Quick Markdown Search");
  console.log("");
  console.log("Usage:");
  console.log("  qmd <command> [options]");
  console.log("");
  console.log("Primary commands:");
  console.log("  qmd query <query>             - Hybrid search with auto expansion + reranking (recommended)");
  console.log("  qmd query 'lex:..\\nvec:...'   - Structured query document (you provide lex/vec/hyde lines)");
  console.log("  qmd search <query>            - Full-text BM25 keywords (no LLM)");
  console.log("  qmd vsearch <query>           - Vector similarity only");
  console.log("  qmd get <file>[:line] [-l N]  - Show a single document, optional line slice");
  console.log("  qmd multi-get <pattern>       - Batch fetch via glob or comma-separated list");
  console.log("  qmd skill show/install        - Show or install the packaged QMD skill");
  console.log("  qmd mcp                       - Start the MCP server (stdio transport for AI agents)");
  console.log("  qmd bench <fixture.json>      - Run search quality benchmarks against a fixture file");
  console.log("");
  console.log("Collections & context:");
  console.log("  qmd collection add/list/remove/rename/show   - Manage indexed folders");
  console.log("  qmd context add/list/rm                      - Attach human-written summaries");
  console.log("  qmd ls [collection[/path]]                   - Inspect indexed files");
  console.log("");
  console.log("Maintenance:");
  console.log("  qmd status                    - View index + collection health");
  console.log("  qmd update [--pull]           - Re-index collections (optionally git pull first)");
  console.log("  qmd embed [-f]                - Generate/refresh vector embeddings");
  console.log("    --max-docs-per-batch <n>    - Cap docs loaded into memory per embedding batch");
  console.log("    --max-batch-mb <n>          - Cap UTF-8 MB loaded into memory per embedding batch");
  console.log("  qmd cleanup                   - Clear caches, vacuum DB");
  console.log("");
  console.log("Query syntax (qmd query):");
  console.log("  QMD queries are either a single expand query (no prefix) or a multi-line");
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
  console.log("    qmd query \"how does auth work\"                # single-line → implicit expand");
  console.log("    qmd query $'lex: CAP theorem\\nvec: consistency'  # typed query document");
  console.log("    qmd query $'lex: \"exact matches\" sports -baseball'  # phrase + negation lex search");
  console.log("    qmd query $'hyde: Hypothetical answer text'       # hyde-only document");
  console.log("");
  console.log("  Constraints:");
  console.log("    - Standalone expand queries cannot mix with typed lines.");
  console.log("    - Query documents allow only lex:, vec:, or hyde: prefixes.");
  console.log("    - Each typed line must be single-line text with balanced quotes.");
  console.log("");
  console.log("AI agents & integrations:");
  console.log("  - Run `qmd mcp` to expose the MCP server (stdio) to agents/IDEs.");
  console.log("  - `qmd skill install` installs the QMD skill into ./.agents/skills/qmd.");
  console.log("  - Use `qmd skill install --global` for ~/.agents/skills/qmd.");
  console.log("  - `qmd --skill` is kept as an alias for `qmd skill show`.");
  console.log("  - Advanced: `qmd mcp --http ...` and `qmd mcp --http --daemon` are optional for custom transports.");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use a named index (default: index)");
  console.log("  QMD_EDITOR_URI             - Editor link template for clickable TTY search output");
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
  console.log(`qmd ${versionStr}`);
}
