#!/usr/bin/env node
// Regenerate src/embedded-skills.ts from skills/lotl/* contents.
// Run after editing any skills/lotl/ file to keep the packaged skill in sync.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKILL_DIR = "skills/lotl";
const OUT = "src/embedded-skills.ts";

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const rel = relative(base, p).split(sep).join("/");
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push({ rel, content: readFileSync(p, "utf-8") });
  }
  return out;
}

const files = walk(SKILL_DIR);
const entries = files
  .map(f => `  ${JSON.stringify(f.rel)}: ${JSON.stringify(Buffer.from(f.content, "utf-8").toString("base64"))}`)
  .join(",\n");

const src = `// Generated from skills/lotl source files. Regenerate via scripts/regen-embedded-skill.mjs.

export type EmbeddedSkillFile = {
  relativePath: string;
  content: string;
};

const EMBEDDED_LOTL_SKILL_BASE64: Record<string, string> = {
${entries}
};

export function getEmbeddedLotlSkillFiles(): EmbeddedSkillFile[] {
  return Object.entries(EMBEDDED_LOTL_SKILL_BASE64).map(([relativePath, encoded]) => ({
    relativePath,
    content: Buffer.from(encoded, "base64").toString("utf-8"),
  }));
}

/** @deprecated use getEmbeddedLotlSkillFiles */
export const getEmbeddedQmdSkillFiles = getEmbeddedLotlSkillFiles;

export function getEmbeddedLotlSkillContent(relativePath: string = "SKILL.md"): string {
  const encoded = EMBEDDED_LOTL_SKILL_BASE64[relativePath];
  if (encoded == null) return "";
  return Buffer.from(encoded, "base64").toString("utf-8");
}

/** @deprecated use getEmbeddedLotlSkillContent */
export const getEmbeddedQmdSkillContent = getEmbeddedLotlSkillContent;
`;

writeFileSync(OUT, src);
console.log(`Regenerated ${OUT} from ${files.length} file(s):`);
for (const f of files) console.log(`  ${f.rel} (${f.content.length} chars)`);
