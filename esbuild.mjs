import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // The Agent SDK is ESM-only and spawns the CLI; it is loaded from node_modules at runtime.
  external: ["vscode", "@anthropic-ai/claude-agent-sdk"],
  outfile: "dist/extension.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

// The webview runs in Chromium, but we still transpile down to ES2019 so the
// bundle carries no optional chaining or nullish coalescing.
const webview = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2019",
  outfile: "dist/webview.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

// Injected into pages of Relay's browser; `__relayPicker` holds the functions Relay calls back.
const picker = {
  entryPoints: ["src/picker/picker.ts"],
  bundle: true,
  format: "iife",
  globalName: "__relayPicker",
  platform: "browser",
  target: "es2019",
  outfile: "dist/picker.js",
  minify: production,
  logLevel: "info",
};

// Mermaid is a few MB, so it gets its own bundle that the webview loads only when a chat has a diagram.
const mermaid = {
  entryPoints: ["src/webview/mermaidBundle.ts"],
  bundle: true,
  format: "iife",
  globalName: "__relayMermaid",
  platform: "browser",
  target: "es2019",
  outfile: "dist/mermaid.js",
  minify: true,
  logLevel: "info",
};

const css = {
  entryPoints: ["src/webview/styles.css"],
  bundle: true,
  outfile: "dist/webview.css",
  minify: production,
  logLevel: "info",
};

if (watch) {
  const contexts = await Promise.all([extension, webview, picker, mermaid, css].map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([extension, webview, picker, mermaid, css].map((c) => esbuild.build(c)));
}
