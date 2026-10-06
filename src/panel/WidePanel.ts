import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import type { Scheduler } from "../backend/scheduler";
import { buildHtml } from "./html";
import { PanelHost, webviewChannel } from "./PanelHost";

/** Sessions on the left, the open session on the right, as an editor tab. One at a time. */
export class WidePanel {
  private static current: WidePanel | undefined;

  static show(extensionUri: vscode.Uri, api: SessionsApi, scheduler: Scheduler): void {
    if (WidePanel.current) {
      WidePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("relay.wide", "Relay", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activity.svg");
    WidePanel.current = new WidePanel(panel, extensionUri, api, scheduler);
  }

  static isViewing(sessionId: string): boolean {
    return !!WidePanel.current && WidePanel.current.host.isViewing(sessionId);
  }

  /** Shows the session in the tab if it's open; false when there is no tab. */
  static open(sessionId: string): boolean {
    if (!WidePanel.current) return false;
    WidePanel.current.panel.reveal();
    WidePanel.current.host.open(sessionId);
    return true;
  }

  /** The session open in the tab, if there is a tab. */
  static selectedSession(): string | undefined {
    return WidePanel.current ? WidePanel.current.host.selectedSession : undefined;
  }

  /** Adds text to the tab's message box on that session; false when there is no tab. */
  static insertText(sessionId: string | undefined, text: string): boolean {
    if (!WidePanel.current) return false;
    WidePanel.current.panel.reveal();
    WidePanel.current.host.insertText(sessionId, text);
    return true;
  }

  /** Shows the tab with the cursor in its message box; false when there is no tab. */
  static focusInput(): boolean {
    if (!WidePanel.current) return false;
    WidePanel.current.panel.reveal();
    WidePanel.current.host.focusInput();
    return true;
  }

  /** Switches the tab between sessions and scheduled tasks; false when the tab isn't showing. */
  static toggleScheduled(): boolean {
    if (!WidePanel.current || !WidePanel.current.panel.visible) return false;
    WidePanel.current.host.toggleScheduled();
    return true;
  }

  /** Opens or closes the settings in the tab; false when the tab isn't showing. */
  static toggleSettings(): boolean {
    if (!WidePanel.current || !WidePanel.current.panel.visible) return false;
    WidePanel.current.host.toggleSettings();
    return true;
  }

  static startNew(): boolean {
    if (!WidePanel.current || !WidePanel.current.panel.visible) return false;
    WidePanel.current.host.startNew();
    return true;
  }

  private readonly host: PanelHost;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    api: SessionsApi,
    scheduler: Scheduler,
  ) {
    panel.webview.html = buildHtml(panel.webview, extensionUri, "wide");
    this.host = new PanelHost(webviewChannel(panel.webview), api, scheduler, "wide", () => panel.visible);
    // A session that finished while the tab was in the background is marked seen once it shows again.
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.host.refresh();
    });
    panel.onDidDispose(() => {
      this.host.dispose();
      WidePanel.current = undefined;
    });
  }
}
