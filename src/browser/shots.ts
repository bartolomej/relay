import * as fs from "fs/promises";
import * as path from "path";

/** Older screenshots are deleted; notes rarely point back further than this. */
const KEEP = 50;

/** Saves a note's screenshot under a sortable timestamp and returns its path. */
export async function saveShot(dir: string, png: Buffer): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  await fs.writeFile(file, png);
  const shots = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
  await Promise.all(shots.slice(0, Math.max(0, shots.length - KEEP)).map((f) => fs.rm(path.join(dir, f), { force: true })));
  return file;
}
