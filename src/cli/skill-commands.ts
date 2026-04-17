/**
 * cli/skill-commands.ts — `qmd skill show/install` handlers + path helpers.
 *
 * Extracted from cli/qmd.ts. Installs the embedded agent skill to either
 * the project or user scope, optionally symlinking it under `.claude/skills`
 * so Claude Code discovers it automatically. Uses a relative symlink so the
 * link doesn't break when the project directory is moved.
 *
 * `pathExists` and `removePath` are kept local to this module — they're
 * only used by the skill-install flow. Promote to a shared helper if another
 * slice needs them later.
 */

import { lstatSync, rmSync, unlinkSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, readlinkSync } from "fs";
import { dirname, relative as relativePath } from "path";
import { createInterface } from "readline/promises";
import { getPwd, homedir, resolve } from "../store.js";
import { getEmbeddedQmdSkillContent, getEmbeddedQmdSkillFiles } from "../embedded-skills.js";

export function getSkillInstallDir(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".agents", "skills", "qmd")
    : resolve(getPwd(), ".agents", "skills", "qmd");
}

export function getClaudeSkillLinkPath(globalInstall: boolean): string {
  return globalInstall
    ? resolve(homedir(), ".claude", "skills", "qmd")
    : resolve(getPwd(), ".claude", "skills", "qmd");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removePath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  } else {
    unlinkSync(path);
  }
}

export function showSkill(): void {
  console.log("QMD Skill (embedded)");
  console.log("");
  const content = getEmbeddedQmdSkillContent();
  process.stdout.write(content.endsWith("\n") ? content : content + "\n");
}

function writeEmbeddedSkill(targetDir: string, force: boolean): void {
  if (pathExists(targetDir)) {
    if (!force) {
      throw new Error(`Skill already exists: ${targetDir} (use --force to replace it)`);
    }
    removePath(targetDir);
  }

  mkdirSync(targetDir, { recursive: true });
  for (const file of getEmbeddedQmdSkillFiles()) {
    const destination = resolve(targetDir, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, "utf-8");
  }
}

/** Returns true if a symlink was created or already matched; false if the
 *  caller's parent dir already resolves to the same directory (skill is
 *  already visible; linking would create a loop). */
function ensureClaudeSymlink(linkPath: string, targetDir: string, force: boolean): boolean {
  const parentDir = dirname(linkPath);
  if (pathExists(parentDir)) {
    const resolvedTargetDir = realpathSync(dirname(targetDir));
    const resolvedLinkParent = realpathSync(parentDir);

    if (resolvedTargetDir === resolvedLinkParent) {
      return false;
    }
  }

  const linkTarget = relativePath(parentDir, targetDir) || ".";

  mkdirSync(parentDir, { recursive: true });

  if (pathExists(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && readlinkSync(linkPath) === linkTarget) {
      return true;
    }
    if (!force) {
      throw new Error(`Claude skill path already exists: ${linkPath} (use --force to replace it)`);
    }
    removePath(linkPath);
  }

  symlinkSync(linkTarget, linkPath, "dir");
  return true;
}

async function shouldCreateClaudeSymlink(linkPath: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Tip: create a Claude symlink manually at ${linkPath}`);
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Create a symlink in ${linkPath}? [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export async function installSkill(globalInstall: boolean, force: boolean, autoYes: boolean): Promise<void> {
  const installDir = getSkillInstallDir(globalInstall);
  writeEmbeddedSkill(installDir, force);
  console.log(`✓ Installed QMD skill to ${installDir}`);

  const claudeLinkPath = getClaudeSkillLinkPath(globalInstall);
  if (!(await shouldCreateClaudeSymlink(claudeLinkPath, autoYes))) {
    return;
  }

  const linked = ensureClaudeSymlink(claudeLinkPath, installDir, force);
  if (linked) {
    console.log(`✓ Linked Claude skill at ${claudeLinkPath}`);
  } else {
    console.log(`✓ Claude already sees the skill via ${dirname(claudeLinkPath)}`);
  }
}
