/**
 * cli/format.ts — pure display-formatting helpers, extracted from cli/lotl.ts.
 *
 * All functions are stateless: same input → same output, no closures over
 * module state or DB/config. Part of the cli/lotl.ts split (see docs/TODO.md
 * backlog). Keep this module free of DB / config / async / side-effects.
 */

/** "Xs" under 1 min, "Xm Ys" under 1 hour, "Xh Ym" otherwise. */
export function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** "Xs ago" / "Xm ago" / "Xh ago" / "Xd ago" — coarse-grained, good enough for `qmd status`. */
export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "Xms" under 1s, "X.Ys" otherwise. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Human-readable byte size: "X B" / "X.Y KB" / "X.Y MB" / "X.Y GB". Binary (1024) base. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Unix `ls -l` style time column: "Apr 17  2026" for old entries, "Apr 17 14:32" for recent. */
export function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, " ");

  if (date < sixMonthsAgo) {
    const year = date.getFullYear();
    return `${month} ${day}  ${year}`;
  } else {
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return `${month} ${day} ${hours}:${minutes}`;
  }
}

/** Filled-block progress bar: `renderProgressBar(42)` → `"█████████████░░░░░░░░░░░░░░░░░"` */
export function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}
