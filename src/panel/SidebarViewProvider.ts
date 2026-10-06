import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import type { Scheduler } from "../backend/scheduler";
import { buildHtml } from "./html";
import { PanelHost, webviewChannel } from "./PanelHost";

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "relay.sidebar";
  private host: PanelHost | undefined;
  private view: vscode.WebviewView | undefined;
  private badge: vscode.ViewBadge | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly api: SessionsApi,
    private readonly scheduler: Scheduler,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    view.webview.html = buildHtml(view.webview, this.extensionUri, "sidebar");
    view.badge = this.badge;
    const host = new PanelHost(webviewChannel(view.webview), this.api, this.scheduler, "sidebar", () => view.visible);
    this.host = host;
    // A session that finished while hidden is marked seen once the view shows again.
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) host.refresh();
    });
    view.onDidDispose(() => {
      visibility.dispose();
      host.dispose();
      this.host = undefined;
      this.view = undefined;
    });
  }

  startNew(): void {
    if (this.view) this.view.show(true);
    if (this.host) this.host.startNew();
  }

  toggleScheduled(): void {
    if (this.view) this.view.show(true);
    if (this.host) this.host.toggleScheduled();
  }

  async toggleSettings(): Promise<void> {
    const host = await this.reveal();
    if (host) host.toggleSettings();
  }

  /** Count on the activity bar icon; shows even while the view is closed. */
  setBadge(badge: vscode.ViewBadge | undefined): void {
    this.badge = badge;
    if (this.view) this.view.badge = badge;
  }

  isViewing(sessionId: string): boolean {
    return !!this.host && this.host.isViewing(sessionId);
  }

  selectedSession(): string | undefined {
    return this.host ? this.host.selectedSession : undefined;
  }

  async open(sessionId: string): Promise<void> {
    const host = await this.reveal();
    if (host) host.open(sessionId);
  }

  async insertText(sessionId: string | undefined, text: string): Promise<void> {
    const host = await this.reveal();
    if (host) host.insertText(sessionId, text);
  }

  async focusInput(): Promise<void> {
    const host = await this.reveal();
    if (host) host.focusInput();
  }

  /** Before the view first opens, the host doesn't exist yet. */
  private async reveal(): Promise<PanelHost | undefined> {
    await vscode.commands.executeCommand(`${SidebarViewProvider.viewType}.focus`);
    for (let i = 0; i < 40 && !this.host; i++) await new Promise((r) => setTimeout(r, 50));
    return this.host;
  }
}
