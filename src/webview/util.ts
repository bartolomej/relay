export function esc(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "2m 14s" style elapsed time for running sessions. */
export function elapsed(sinceMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "4m ago", "1h 20m", "yesterday", "3d" for finished sessions. */
export function ago(atMs: number, now: number): string {
  const m = Math.max(0, Math.floor((now - atMs) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d}d`;
}


/** "43m", "2h 10m", "3d 4h" until a reset time. */
export function until(atMs: number, now: number): string {
  const m = Math.max(0, Math.ceil((atMs - now) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "850", "1.5k", "48k", "1.2M", "34M" token counts: one decimal below 10, none above. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  const [v, unit] = n < 999_500 ? [n / 1000, "k"] : [n / 1_000_000, "M"];
  return `${v < 9.95 ? Number(v.toFixed(1)) : Math.round(v)}${unit}`;
}

/** Colour band for a 0-100 fill: fine, getting close, nearly out. */
export function level(percent: number): "ok" | "warn" | "crit" {
  return percent >= 90 ? "crit" : percent >= 75 ? "warn" : "ok";
}

export const isHtml = (path: string): boolean => /\.html?$/i.test(path);

/**
 * VS Code's right-click menu on an HTML file link offers Open in Relay's
 * browser. The chat root adds the session, so the path resolves in its folder.
 */
export function htmlLinkContext(path: string): string {
  return JSON.stringify({ webviewSection: "htmlLink", path });
}
