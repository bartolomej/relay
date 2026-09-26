import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { Worktree } from "../api/types";

/** Where session worktrees live, outside the project so search and watchers don't see copies. */
const WORKTREES_DIR = path.join(os.homedir(), ".relay", "worktrees");

export type MergeResult = { ok: true; merged: boolean } | { ok: false; conflicts: string[] } | { ok: false; error: string };

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).then(
    (out) => out === "true",
    () => false,
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "session";
}

/**
 * Checks out a new branch off the current one in its own worktree. The agent
 * works in the same subfolder of it that `cwd` is of the project.
 */
export async function createWorktree(cwd: string, sessionId: string, title: string): Promise<Worktree> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const base = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => {
    throw new Error("Can't start a worktree: the project isn't on a branch (detached HEAD).");
  });
  const id = sessionId.split("-").pop() || sessionId;
  const branch = `relay/${slug(title)}-${id}`;
  const wtPath = path.join(WORKTREES_DIR, `${path.basename(root)}-${id}`);
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"]);
  await linkNodeModules(root, wtPath);
  return { path: wtPath, cwd: path.join(wtPath, path.relative(root, cwd)), branch, base };
}

/** Git doesn't copy ignored folders; share the project's installed packages instead. */
async function linkNodeModules(root: string, wtPath: string): Promise<void> {
  const source = path.join(root, "node_modules");
  const link = path.join(wtPath, "node_modules");
  if (!(await exists(source)) || (await exists(link))) return;
  await fs.symlink(source, link, "dir");
  // `node_modules/` in .gitignore only matches folders, not a symlink; keep it out of commits.
  const ignored = await git(wtPath, ["check-ignore", "-q", "node_modules"]).then(
    () => true,
    () => false,
  );
  if (ignored) return;
  const exclude = path.join(await git(wtPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "info", "exclude");
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, "\n/node_modules\n");
}

/**
 * Commits what's left in the worktree, brings its branch up to date with the
 * base, merges it into the project with a merge commit, then removes the
 * worktree and branch. Conflicts are left for the agent to resolve in the
 * worktree; nothing is changed in the project folder unless the merge is clean.
 */
export async function mergeWorktree(projectCwd: string, wt: Worktree, title: string): Promise<MergeResult> {
  try {
    if (await git(wt.path, ["status", "--porcelain"])) {
      await git(wt.path, ["add", "-A"]);
      await git(wt.path, ["commit", "-m", title]);
    }
    try {
      await git(wt.path, ["merge", "--no-edit", wt.base]);
    } catch (err) {
      const conflicts = (await git(wt.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      await git(wt.path, ["merge", "--abort"]).catch(() => undefined);
      if (conflicts.length) return { ok: false, conflicts };
      throw err;
    }

    const current = await git(projectCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (current !== wt.base) {
      return { ok: false, error: `The project folder is on ${current || "a detached HEAD"}, not ${wt.base}. Switch back to ${wt.base} and complete again.` };
    }
    const ahead = Number(await git(projectCwd, ["rev-list", "--count", `${wt.base}..${wt.branch}`]));
    if (ahead > 0) {
      try {
        await git(projectCwd, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${wt.branch}: ${title}`, wt.branch]);
      } catch (err) {
        await git(projectCwd, ["merge", "--abort"]).catch(() => undefined);
        throw err;
      }
    }

    // Everything tracked is committed by now; --force only drops ignored files like build output.
    await git(projectCwd, ["worktree", "remove", "--force", wt.path]);
    await git(projectCwd, ["branch", "-d", wt.branch]);
    return { ok: true, merged: ahead > 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
