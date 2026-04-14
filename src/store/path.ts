// =============================================================================
// Path utilities
// =============================================================================

import { realpathSync, mkdirSync } from "node:fs";
import type { Database } from "../db.js";
import { getStoreCollections, getCollectionByName } from "./store-collections.js";

// USERPROFILE fallback for Windows MCP subprocess case (upstream tobi/qmd 77e71d0).
// MCP clients spawn QMD as a subprocess passing USERPROFILE but not HOME; without
// the fallback we open an empty /tmp DB instead of the user's actual index.
const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";

export function homedir(): string {
  return HOME;
}

/**
 * Check if a path is absolute.
 * Supports:
 * - Unix paths: /path/to/file
 * - Windows native: C:\path or C:/path
 * - Git Bash: /c/path or /C/path (C-Z drives, excluding A/B floppy drives)
 *
 * Note: /c without trailing slash is treated as Unix path (directory named "c"),
 * while /c/ or /c/path are treated as Git Bash paths (C: drive).
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;

  // Unix absolute path
  if (path.startsWith('/')) {
    // Check if it's a Git Bash style path like /c/ or /c/Users (C-Z only, not A or B)
    // Requires path[2] === '/' to distinguish from Unix paths like /c or /cache
    // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
    if (!isWSL() && path.length >= 3 && path[2] === '/') {
      const driveLetter = path[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        return true;
      }
    }
    // Any other path starting with / is Unix absolute
    return true;
  }

  // Windows native path: C:\ or C:/ (any letter A-Z)
  if (path.length >= 2 && /[a-zA-Z]/.test(path[0]!) && path[1] === ':') {
    return true;
  }

  return false;
}

/**
 * Normalize path separators to forward slashes.
 * Converts Windows backslashes to forward slashes.
 */
export function normalizePathSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Detect if running inside WSL (Windows Subsystem for Linux).
 * On WSL, paths like /c/work/... are valid drvfs mount points, not Git Bash paths.
 */
function isWSL(): boolean {
  return !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * Get the relative path from a prefix.
 * Returns null if path is not under prefix.
 * Returns empty string if path equals prefix.
 */
export function getRelativePathFromPrefix(path: string, prefix: string): string | null {
  // Empty prefix is invalid
  if (!prefix) {
    return null;
  }

  const normalizedPath = normalizePathSeparators(path);
  const normalizedPrefix = normalizePathSeparators(prefix);

  // Ensure prefix ends with / for proper matching
  const prefixWithSlash = !normalizedPrefix.endsWith('/')
    ? normalizedPrefix + '/'
    : normalizedPrefix;

  // Exact match
  if (normalizedPath === normalizedPrefix) {
    return '';
  }

  // Check if path starts with prefix
  if (normalizedPath.startsWith(prefixWithSlash)) {
    return normalizedPath.slice(prefixWithSlash.length);
  }

  return null;
}

export function resolve(...paths: string[]): string {
  if (paths.length === 0) {
    throw new Error("resolve: at least one path segment is required");
  }

  // Normalize all paths to use forward slashes
  const normalizedPaths = paths.map(normalizePathSeparators);

  let result = '';
  let windowsDrive = '';

  // Check if first path is absolute
  const firstPath = normalizedPaths[0]!;
  if (isAbsolutePath(firstPath)) {
    result = firstPath;

    // Extract Windows drive letter if present
    if (firstPath.length >= 2 && /[a-zA-Z]/.test(firstPath[0]!) && firstPath[1] === ':') {
      windowsDrive = firstPath.slice(0, 2);
      result = firstPath.slice(2);
    } else if (!isWSL() && firstPath.startsWith('/') && firstPath.length >= 3 && firstPath[2] === '/') {
      // Git Bash style: /c/ -> C: (C-Z drives only, not A or B)
      // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
      const driveLetter = firstPath[1];
      if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
        windowsDrive = driveLetter.toUpperCase() + ':';
        result = firstPath.slice(2);
      }
    }
  } else {
    // Start with PWD or cwd, then append the first relative path
    const pwd = normalizePathSeparators(process.env.PWD || process.cwd());

    // Extract Windows drive from PWD if present
    if (pwd.length >= 2 && /[a-zA-Z]/.test(pwd[0]!) && pwd[1] === ':') {
      windowsDrive = pwd.slice(0, 2);
      result = pwd.slice(2) + '/' + firstPath;
    } else {
      result = pwd + '/' + firstPath;
    }
  }

  // Process remaining paths
  for (let i = 1; i < normalizedPaths.length; i++) {
    const p = normalizedPaths[i]!;
    if (isAbsolutePath(p)) {
      // Absolute path replaces everything
      result = p;

      // Update Windows drive if present
      if (p.length >= 2 && /[a-zA-Z]/.test(p[0]!) && p[1] === ':') {
        windowsDrive = p.slice(0, 2);
        result = p.slice(2);
      } else if (!isWSL() && p.startsWith('/') && p.length >= 3 && p[2] === '/') {
        // Git Bash style (C-Z drives only, not A or B)
        // Skipped on WSL where /c/ is a valid drvfs mount point, not a drive letter
        const driveLetter = p[1];
        if (driveLetter && /[c-zC-Z]/.test(driveLetter)) {
          windowsDrive = driveLetter.toUpperCase() + ':';
          result = p.slice(2);
        } else {
          windowsDrive = '';
        }
      } else {
        windowsDrive = '';
      }
    } else {
      // Relative path - append
      result = result + '/' + p;
    }
  }

  // Normalize . and .. components
  const parts = result.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.') {
      normalized.push(part);
    }
  }

  // Build final path
  const finalPath = '/' + normalized.join('/');

  // Prepend Windows drive if present
  if (windowsDrive) {
    return windowsDrive + finalPath;
  }

  return finalPath;
}

// Flag to indicate production mode (set by qmd.ts at startup)
let _productionMode = false;

export function enableProductionMode(): void {
  _productionMode = true;
}

/** Reset production mode flag -- only for testing. */
export function _resetProductionModeForTesting(): void {
  _productionMode = false;
}

export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch { }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}

export function getPwd(): string {
  return process.env.PWD || process.cwd();
}

export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// =============================================================================
// Virtual Path Utilities (qmd://)
// =============================================================================

export type VirtualPath = {
  collectionName: string;
  path: string;  // relative path within collection
};

/**
 * Normalize explicit virtual path formats to standard qmd:// format.
 * Only handles paths that are already explicitly virtual:
 * - qmd://collection/path.md (already normalized)
 * - qmd:////collection/path.md (extra slashes - normalize)
 * - //collection/path.md (missing qmd: prefix - add it)
 *
 * Does NOT handle:
 * - collection/path.md (bare paths - could be filesystem relative)
 * - :linenum suffix (should be parsed separately before calling this)
 */
export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  // Handle qmd:// with extra slashes: qmd:////collection/path -> qmd://collection/path
  if (path.startsWith('qmd:')) {
    // Remove qmd: prefix and normalize slashes
    path = path.slice(4);
    // Remove leading slashes and re-add exactly two
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Handle //collection/path (missing qmd: prefix)
  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  // Return as-is for other cases (filesystem paths, docids, bare collection/path, etc.)
  return path;
}

/**
 * Parse a virtual path like "qmd://collection-name/path/to/file.md"
 * into its components.
 * Also supports collection root: "qmd://collection-name/" or "qmd://collection-name"
 */
export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  // Normalize the path first
  const normalized = normalizeVirtualPath(virtualPath);

  // Match: qmd://collection-name[/optional-path]
  // Allows: qmd://name, qmd://name/, qmd://name/path
  const match = normalized.match(/^qmd:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  return {
    collectionName: match[1],
    path: match[2] ?? '',  // Empty string for collection root
  };
}

/**
 * Build a virtual path from collection name and relative path.
 */
export function buildVirtualPath(collectionName: string, path: string): string {
  return `qmd://${collectionName}/${path}`;
}

/**
 * Check if a path is explicitly a virtual path.
 * Only recognizes explicit virtual path formats:
 * - qmd://collection/path.md
 * - //collection/path.md
 *
 * Does NOT consider bare collection/path.md as virtual - that should be
 * handled separately by checking if the first component is a collection name.
 */
export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  // Explicit qmd:// prefix (with any number of slashes)
  if (trimmed.startsWith('qmd:')) return true;

  // //collection/path format (missing qmd: prefix)
  if (trimmed.startsWith('//')) return true;

  return false;
}

/**
 * Resolve a virtual path to absolute filesystem path.
 */
export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  return resolve(coll.pwd, parsed.path);
}

/**
 * Convert an absolute filesystem path to a virtual path.
 * Returns null if the file is not in any indexed collection.
 */
export function toVirtualPath(db: Database, absolutePath: string): string | null {
  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Find which collection this absolute path belongs to
  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      // Extract relative path
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      // Verify this document exists in the database
      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}
