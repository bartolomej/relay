import * as path from "path";
import { findExecutable } from "./binaries";

/** The server's name as both agents see it; Claude's tools become mcp__relay_browser__…. */
export const BROWSER_MCP = "relay_browser";

/** Tells the agent which browser is the user's, since they may have another browser MCP of their own. */
export const BROWSER_PROMPT =
  "The relay_browser tools drive Relay's browser: the Chrome window the user is looking at, with their logins and the app open. Use them, not another browser, to look at the app or check your changes; the user sees what you do there. " +
  "Take screenshots without a filePath so they come back to you and nothing is written to disk; if you do save one, delete it when you're done, and never save into .relay/shots, which holds the user's notes.";

export interface McpCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Chrome DevTools MCP attached to Relay's running browser, instead of the one it
 * would start. It's the same server the user runs with `npx chrome-devtools-mcp`.
 */
export function browserMcp(browserUrl: string): McpCommand {
  const npx = findExecutable("npx");
  if (!npx) throw new Error("Browser access needs npx, which comes with Node.js.");
  // npx starts node by name, so node's folder goes on the PATH the agent's CLI gives it.
  const PATH = [path.dirname(npx), process.env.PATH || ""].join(path.delimiter);
  return { command: npx, args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", browserUrl, "--no-usage-statistics"], env: { PATH } };
}
