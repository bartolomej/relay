import * as fs from "fs";
import * as path from "path";

// Anything shaped like a file path with an extension: src/a.ts, ./x/y.md, /abs/z.json, package.json.
// Most matches aren't files ("e.g.", "v1.2"); the existence check below weeds them out.
const CANDIDATE = /(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,10}\b/g;

/** Strings in the texts that name an existing file or folder, relative to cwd or absolute. */
export function findLinkable(texts: string[], cwd: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.match(CANDIDATE) || []) {
      if (seen.has(match)) continue;
      seen.add(match);
      if (exists(resolveIn(cwd, match))) found.push(match);
    }
  }
  return found;
}

/**
 * Recent existence checks by absolute path. The open chat is rescanned on every
 * state push, many times a second while an agent streams, so each path hits the
 * disk at most once per CHECK_TTL_MS; a file the agent just wrote links soon after.
 */
const checked = new Map<string, { exists: boolean; at: number }>();
const CHECK_TTL_MS = 5_000;
/** Streaming text yields many half-typed paths; past this many the cache starts over. */
const MAX_CHECKED = 5_000;

function exists(abs: string): boolean {
  const now = Date.now();
  const hit = checked.get(abs);
  if (hit && now - hit.at < CHECK_TTL_MS) return hit.exists;
  if (checked.size >= MAX_CHECKED) checked.clear();
  const result = fs.existsSync(abs);
  checked.set(abs, { exists: result, at: now });
  return result;
}

export function resolveIn(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}
