/** Shared palette. Kept small and semantic so a theme swap is one file. */
export const C = {
  fg: "#d8d8d8",
  dim: "#6b6b6b",
  faint: "#3f3f3f",
  accent: "#00a0ff",
  running: "#f0c000",
  done: "#3fb950",
  error: "#f05050",
  queued: "#6b6b6b",
  thinking: "#a070d0",
  bg: "#101010",
  bgAlt: "#181818",
  selBg: "#213a5a",
} as const;

export const statusColor = (s: string): string =>
  s === "running" ? C.running : s === "error" ? C.error : s === "done" ? C.done : C.queued;

export const statusGlyph = (s: string): string =>
  s === "running" ? "◉" : s === "error" ? "✖" : s === "done" ? "●" : "○";

/**
 * Truncate-or-pad to exactly `w` cells.
 *
 * OpenTUI does not clip overlong text to the container -- it emits the whole
 * string and lets the terminal wrap it, which collapses a row-based layout.
 * Every row this app paints is therefore clipped explicitly.
 */
export function fit(s: string, w: number): string {
  if (w <= 0) return "";
  return s.length > w ? `${s.slice(0, Math.max(0, w - 1))}\u2026` : s.padEnd(w);
}
