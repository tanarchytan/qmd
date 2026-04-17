/**
 * cli/terminal.ts — terminal styling and control, extracted from cli/qmd.ts.
 *
 * Three surfaces:
 *   - `c` — ANSI color codes that auto-disable when stdout isn't a TTY or
 *     NO_COLOR is set. Empty strings collapse to nothing at runtime, so
 *     `${c.yellow}warn${c.reset}` is safe in non-TTY pipelines.
 *   - `cursor` — show/hide the terminal cursor (stderr escape sequences).
 *     Auto-restored on SIGINT / SIGTERM so `^C` doesn't leave a hidden cursor.
 *   - `progress` — Windows Terminal / ConEmu OSC 9;4 taskbar progress indicator.
 *     No-op outside a TTY. Stateful: call clear() when a long operation ends.
 */

export const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

export const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

export const cursor = {
  hide() { process.stderr.write("\x1b[?25l"); },
  show() { process.stderr.write("\x1b[?25h"); },
};

// Restore the cursor on abnormal exit so a ^C during a progress spinner
// doesn't leave the terminal in a hidden-cursor state.
process.on("SIGINT", () => { cursor.show(); process.exit(130); });
process.on("SIGTERM", () => { cursor.show(); process.exit(143); });

export const isTTY = process.stderr.isTTY;

export const progress = {
  set(percent: number) {
    if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    if (isTTY) process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

// =============================================================================
// Uniform message formatters — use these to keep color conventions consistent
// across the CLI. Each returns a string; callers pick stdout vs stderr vs log.
// =============================================================================

/** Yellow-tagged warning line. Intended for recoverable user errors and tips. */
export function warn(message: string): string {
  return `${c.yellow}${message}${c.reset}`;
}

/** Green ✓ prefixed success line. Use after completing a user-visible action. */
export function success(message: string): string {
  return `${c.green}✓${c.reset} ${message}`;
}

/** Dim-grey info / hint line. Use for secondary context that shouldn't grab focus. */
export function info(message: string): string {
  return `${c.dim}${message}${c.reset}`;
}
