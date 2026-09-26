import { execFile } from "child_process";
import * as fs from "fs";
import { findExecutable } from "../backend/binaries";

/**
 * Relay's own HTTPS port on the tailnet. Not 443, so turning Remote off never
 * touches whatever else the user serves there.
 */
export const HTTPS_PORT = 8443;

/** The Mac App Store and standalone apps carry the CLI inside the app bundle. */
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function findTailscale(override?: string): string | undefined {
  const found = findExecutable("tailscale", override);
  if (found || override) return found;
  return fs.existsSync(APP_CLI) ? APP_CLI : undefined;
}

interface Result {
  ok: boolean;
  output: string;
}

function run(cli: string, args: string[], timeoutMs: number): Promise<Result> {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** This Mac's name on the tailnet, e.g. "macbook.tail1234.ts.net"; throws with a readable reason. */
export async function tailnetName(cli: string): Promise<string> {
  const res = await run(cli, ["status", "--json"], 10_000);
  let status: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    status = JSON.parse(res.output);
  } catch {
    throw new Error(res.output || "Tailscale didn't answer.");
  }
  if (status.BackendState !== "Running") throw new Error(`Tailscale isn't connected (${status.BackendState || "unknown state"}). Open Tailscale and sign in.`);
  const name = status.Self && status.Self.DNSName ? status.Self.DNSName.replace(/\.$/, "") : "";
  if (!name) throw new Error("Tailscale has no name for this Mac. Turn on MagicDNS in the Tailscale admin console.");
  return name;
}

/**
 * Serves the local port at https://<name>:8443 to the tailnet only. The first
 * time, Tailscale waits for HTTPS to be enabled in the admin console; the
 * error then carries the link it printed.
 */
export async function serve(cli: string, localPort: number): Promise<void> {
  const res = await run(cli, ["serve", "--bg", "--yes", `--https=${HTTPS_PORT}`, `http://127.0.0.1:${localPort}`], 20_000);
  if (!res.ok) throw new Error(res.output || "tailscale serve failed.");
}

/** Removes only Relay's entry. */
export async function unserve(cli: string): Promise<void> {
  await run(cli, ["serve", `--https=${HTTPS_PORT}`, "off"], 10_000);
}
