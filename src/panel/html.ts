import * as vscode from "vscode";
import type { Layout } from "./protocol";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, layout: Layout): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const n = nonce();
  // Inline styles: mermaid lays a diagram out in the page, with them, before it becomes an image.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Relay</title>
</head>
<body data-layout="${layout}">
  <div id="app" class="app app-${layout}"></div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
