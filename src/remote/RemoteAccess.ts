import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import qrcode from "qrcode-generator";
import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import { workspaceCwd } from "../panel/PanelHost";
import { RemoteServer } from "./server";
import { remoteStatus } from "./status";
import { findTailscale, HTTPS_PORT, serve, tailnetName, unserve } from "./tailscale";

/** Which window serves the phone. Only one project at a time; a newer one takes over. */
interface Owner {
  id: string;
  project: string;
}

/**
 * The Remote button: serves this project's sessions to the phone through
 * Tailscale, and shows a QR code with the address and access key.
 */
export class RemoteAccess implements vscode.Disposable {
  private server: RemoteServer | undefined;
  /** Set once `tailscale serve` points at our server, so turning off can undo it. */
  private tailscale: string | undefined;
  private key = "";
  /** What the QR page shows: the tailnet address, or why there isn't one. */
  private address: string | undefined;
  private localAddress = "";
  private problem: string | undefined;
  private starting: Promise<void> | undefined;
  private panel: vscode.WebviewPanel | undefined;
  /** This window, as written in the owner file. */
  private readonly id = crypto.randomUUID();
  private readonly ownerFile: string;
  private readonly project = workspaceCwd();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: SessionsApi,
    private readonly tailscalePath: () => string | undefined,
  ) {
    this.ownerFile = path.join(context.globalStorageUri.fsPath, "remote-owner.json");
  }

  turnOn(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async turnOff(): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.server) return;
    const owner = this.readOwner();
    const wasOwner = !!owner && owner.id === this.id;
    if (wasOwner) fs.rmSync(this.ownerFile, { force: true });
    if (this.tailscale && wasOwner) await unserve(this.tailscale);
    this.stop();
  }

  /** A new key locks out every phone until it scans the new code. */
  async resetKey(): Promise<void> {
    this.key = newKey();
    await this.context.secrets.store(this.secretName(), this.key);
    if (this.server) {
      this.server.disconnectAll();
      await this.showCode();
    } else {
      void vscode.window.showInformationMessage("Made a new remote access key. Phones will need to scan the new QR code when you turn Remote on.");
    }
  }

  dispose(): void {
    // Only the server; deactivate() awaits turnOff() to also undo `tailscale serve`.
    this.stop();
  }

  private async start(): Promise<void> {
    this.key = await this.loadKey();
    const server = new RemoteServer(this.api, vscode.Uri.joinPath(this.context.extensionUri, "dist").fsPath, () => this.key);
    const port = await server.listen();
    this.server = server;
    this.claim();
    remoteStatus.set(true);

    let address: string | undefined;
    let problem: string | undefined;
    const cli = findTailscale(this.tailscalePath());
    if (!cli) {
      problem = "Tailscale isn't installed on this Mac. Install it from tailscale.com, sign in on the Mac and the phone with the same account, then turn Remote off and on.";
    } else {
      try {
        const name = await tailnetName(cli);
        await serve(cli, port);
        this.tailscale = cli;
        address = `https://${name}:${HTTPS_PORT}/`;
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
    }
    this.address = address;
    this.localAddress = `http://127.0.0.1:${port}/`;
    this.problem = problem;
    await this.showCode();
  }

  private stop(): void {
    fs.unwatchFile(this.ownerFile);
    if (this.server) this.server.close();
    this.server = undefined;
    this.tailscale = undefined;
    if (this.panel) this.panel.dispose();
    remoteStatus.set(false);
  }

  // -- one window at a time ------------------------------------------------

  /** Takes over from any other window; that one notices the file change and turns itself off. */
  private claim(): void {
    fs.mkdirSync(path.dirname(this.ownerFile), { recursive: true });
    const owner: Owner = { id: this.id, project: this.project };
    fs.writeFileSync(this.ownerFile, JSON.stringify(owner));
    fs.watchFile(this.ownerFile, { interval: 2000 }, () => {
      const current = this.readOwner();
      if (!this.server || (current && current.id === this.id)) return;
      this.stop();
      const where = current ? path.basename(current.project) : "another window";
      void vscode.window.showInformationMessage(`Remote access moved to ${where}.`);
    });
  }

  private readOwner(): Owner | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.ownerFile, "utf8")) as Owner;
    } catch {
      return undefined;
    }
  }

  // -- key -----------------------------------------------------------------

  /** One key per project, kept in the system keychain and reused until reset. */
  private async loadKey(): Promise<string> {
    const saved = await this.context.secrets.get(this.secretName());
    if (saved) return saved;
    const key = newKey();
    await this.context.secrets.store(this.secretName(), key);
    return key;
  }

  private secretName(): string {
    return `relay.remote.key:${this.project}`;
  }

  // -- QR code -------------------------------------------------------------

  private async showCode(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("relay.remote", "Relay Remote", vscode.ViewColumn.Active, { enableScripts: false });
      this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "activity.svg");
      this.panel.onDidDispose(() => (this.panel = undefined));
    }
    this.panel.webview.html = codePage(this.address, this.localAddress, this.key, this.problem, path.basename(this.project));
    this.panel.reveal();
  }
}

function newKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The key goes after #, so the browser keeps it to itself and it never reaches a server or proxy log. */
function withKey(address: string, key: string): string {
  return `${address}#k=${key}`;
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

function codePage(address: string | undefined, localAddress: string, key: string, problem: string | undefined, project: string): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const body = address
    ? `<div class="qr">${qrSvg(withKey(address, key))}</div>
       <p>Scan with your phone's camera. The phone needs Tailscale turned on, signed in to the same account as this Mac.</p>
       <p class="mono">${esc(address)}</p>`
    : `<p class="problem">${esc(problem || "Tailscale isn't available.")}</p>
       <p>Until then, Relay is only reachable from this Mac: <a href="${esc(withKey(localAddress, key))}">open it in a browser here</a>.</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 24px; max-width: 520px; line-height: 1.5; }
    h1 { font-size: 15px; font-weight: 600; margin: 0 0 16px 0; }
    .qr { width: 280px; height: 280px; margin-bottom: 16px; }
    .qr svg { width: 100%; height: 100%; display: block; border-radius: 6px; }
    .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; user-select: all; }
    .muted { color: var(--vscode-descriptionForeground); }
    .problem { color: var(--vscode-errorForeground); }
    a { color: var(--vscode-textLink-foreground); }
  </style>
  <title>Relay Remote</title>
</head>
<body>
  <h1>Remote access is on for ${esc(project)}</h1>
  ${body}
  <p class="muted">Anyone with this code can run your agents. <b>Relay: Reset Remote Access Key</b> makes a new one and signs out every phone.</p>
  <p class="muted">While Remote is on, this Mac stays awake until all agents are done. Closing the lid still puts it to sleep.</p>
</body>
</html>`;
}
