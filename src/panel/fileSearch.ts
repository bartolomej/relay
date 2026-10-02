import * as fs from "fs";
import * as path from "path";

/**
 * Installed libraries, caches and version-control data: never what an @ means.
 * Everything else is listed, gitignored or not, since ignored files such as
 * .env or local configs are often the ones worth pointing the agent at.
 */
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn",
  "node_modules", "bower_components", "jspm_packages", ".yarn", ".pnpm-store",
  "__pycache__", ".venv", "venv", ".tox", ".nox", ".eggs", "site-packages", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".ipynb_checkpoints",
  "vendor", "Pods", ".gradle", ".dart_tool", ".pub-cache",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
]);
const SKIP_FILES = new Set([".DS_Store"]);
/** Folders are listed nearest first, so a huge tree loses its deepest files, not the ones at the top. */
const MAX_FILES = 50_000;
/** A file an agent just wrote shows up within this long. */
const LIST_TTL_MS = 10_000;
const READDIR_BATCH = 64;

interface Entry {
  path: string;
  lower: string;
  /** Where the file name starts in `path`. */
  base: number;
}

const lists = new Map<string, { at: number; files: Promise<Entry[]> }>();

/** Up to `limit` files under `root` matching `query`, best first, as relative paths with forward slashes. */
export async function searchFiles(root: string, query: string, limit: number): Promise<string[]> {
  return rankPaths(await listFiles(root), query, limit);
}

function listFiles(root: string): Promise<Entry[]> {
  const hit = lists.get(root);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;
  const files = walk(root);
  lists.set(root, { at: Date.now(), files });
  return files;
}

/** Breadth-first, so the project's top-level files come first and an empty query lists them. */
async function walk(root: string): Promise<Entry[]> {
  const files: Entry[] = [];
  let dirs = [""];
  while (dirs.length && files.length < MAX_FILES) {
    const next: string[] = [];
    for (let i = 0; i < dirs.length; i += READDIR_BATCH) {
      const batch = dirs.slice(i, i + READDIR_BATCH);
      const listed = await Promise.all(batch.map((rel) => fs.promises.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])));
      for (let j = 0; j < batch.length; j++) {
        const rel = batch[j];
        const entries = listed[j];
        if (rel && (await isCopyOrLibrary(path.join(root, rel), entries))) continue;
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
          const p = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.endsWith(".egg-info")) next.push(p);
          } else if (!SKIP_FILES.has(e.name)) {
            files.push({ path: p, lower: p.toLowerCase(), base: p.length - e.name.length });
          }
        }
      }
    }
    dirs = next;
  }
  return files.slice(0, MAX_FILES);
}

/**
 * A Python virtualenv, whatever it's called, or a git worktree checked out
 * inside the project (as .worktrees/ or .claude/worktrees/), which would list
 * every file again. A submodule's .git points into .git/modules and is kept.
 */
async function isCopyOrLibrary(dir: string, entries: fs.Dirent[]): Promise<boolean> {
  if (entries.some((e) => e.name === "pyvenv.cfg")) return true;
  const git = entries.find((e) => e.name === ".git" && e.isFile());
  if (!git) return false;
  const pointer = await fs.promises.readFile(path.join(dir, ".git"), "utf8").catch(() => "");
  return /[\\/]worktrees[\\/]/.test(pointer);
}

/**
 * Every space-separated term must appear in the path in order, though not
 * necessarily together: "comp ts" finds src/webview/composer.ts. Terms found
 * whole beat scattered ones, the file name beats its folders, and shorter
 * paths break ties.
 */
export function rankPaths(files: Entry[], query: string, limit: number): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return files.slice(0, limit).map((f) => f.path);
  const scored: { path: string; score: number }[] = [];
  for (const f of files) {
    let score = -f.path.length / 10;
    for (const t of terms) {
      const s = termScore(t, f);
      if (s < 0) {
        score = -Infinity;
        break;
      }
      score += s;
    }
    if (score > -Infinity) scored.push({ path: f.path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.path);
}

/** How well one term matches, or -1 if its letters aren't all in the path in order. */
function termScore(term: string, f: Entry): number {
  const whole = f.lower.lastIndexOf(term);
  if (whole >= 0) return 100 + (whole >= f.base ? 40 : 0) + (atBoundary(f.path, whole) ? 20 : 0);
  // Matched from the end, so letters land in the file name before its folders.
  let score = 0;
  let i = f.lower.length;
  for (let k = term.length - 1; k >= 0; k--) {
    if (i === 0) return -1;
    const at = f.lower.lastIndexOf(term[k], i - 1);
    if (at < 0) return -1;
    if (at >= f.base) score += 2;
    if (atBoundary(f.path, at)) score += 6;
    if (k < term.length - 1 && at === i - 1) score += 4;
    i = at;
  }
  return score;
}

/** The start of a word: after a separator, or a capital after a lowercase letter. */
function atBoundary(p: string, at: number): boolean {
  if (at === 0) return true;
  const prev = p[at - 1];
  if ("/-_. ".includes(prev)) return true;
  return p[at] !== p[at].toLowerCase() && prev === prev.toLowerCase();
}
