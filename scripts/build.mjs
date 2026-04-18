#!/usr/bin/env node
// Lotl production build.
//   1. Sync openclaw.plugin.json version with package.json
//   2. Clean dist/ (prevents stale output from surviving a rename/move)
//   3. Run `tsc -p tsconfig.build.json`
//   4. Prepend `#!/usr/bin/env node` to dist/cli/lotl.js and chmod +x
import { execSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync("openclaw.plugin.json", JSON.stringify(manifest, null, 2) + "\n");
}

rmSync("dist", { recursive: true, force: true });

execSync("tsc -p tsconfig.build.json", { stdio: "inherit" });

const cliPath = "dist/cli/lotl.js";
const body = readFileSync(cliPath, "utf8");
writeFileSync(cliPath, "#!/usr/bin/env node\n" + body);
chmodSync(cliPath, 0o755);
