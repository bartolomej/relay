import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import { isActive, minutesLabel, workDir } from "../api/types";
import { keepAwakeSupported } from "../backend/keepAwake";
import { isGitRepo } from "../backend/worktree";
import { findLinkable, resolveIn } from "./fileLinks";
import type { FromWebview, Layout, ToWebview, UiState } from "./protocol";

const PAST_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Glue between one webview and the SessionsApi. The sidebar view and the
 * editor-tab panel each own one of these; the API is shared.
 */
export class PanelHost implements vscode.Disposable {
  private selectedSessionId: string | undefined;
  /** Unread session the user has looked at; marked seen once they select something else. */
  private viewedUnread: string | undefined;
  private showAllPast = false;
  private disposables: vscode.Disposable[] = [];
  private pushQueued = false;
  private gitRepo = false;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly api: SessionsApi,
    private readonly layout: Layout,
    private readonly isVisible: () => boolean,
  ) {
    this.disposables.push(webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m)));
    void isGitRepo(workspaceCwd()).then((yes) => {
      this.gitRepo = yes;
      this.schedulePush();
    });
    const unsubscribe = api.onDidChange(() => this.schedulePush());
    this.disposables.push({ dispose: unsubscribe });
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("relay.keepAwake")) this.schedulePush();
      }),
    );
  }

  dispose(): void {
    this.select(undefined);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Clears the selection so the next message starts a new session. */
  startNew(): void {
    this.select(undefined);
    void this.push().then(() => this.post({ type: "focusInput" }));
  }

  /** Shows this session, e.g. from a notification's Open button. */
  open(sessionId: string): void {
    this.select(sessionId);
    void this.push();
  }

  /** Whether the user can see this session right now in this panel. */
  isViewing(sessionId: string): boolean {
    return this.selectedSessionId === sessionId && this.isVisible();
  }

  refresh(): void {
    this.schedulePush();
  }

  private select(id: string | undefined): void {
    if (this.viewedUnread && this.viewedUnread !== id) void this.api.markSeen(this.viewedUnread);
    if (this.viewedUnread !== id) this.viewedUnread = undefined;
    this.selectedSessionId = id;
  }

  private post(msg: ToWebview): Thenable<boolean> {
    return this.webview.postMessage(msg);
  }

  private schedulePush(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setTimeout(() => {
      this.pushQueued = false;
      void this.push();
    }, 40);
  }

  private async push(): Promise<void> {
    const [providers, usage, sessions] = await Promise.all([this.api.listProviders(), this.api.getUsage(), this.api.listSessions()]);
    if (this.selectedSessionId && !sessions.some((s) => s.id === this.selectedSessionId)) {
      this.selectedSessionId = undefined;
    }
    const selected = sessions.find((s) => s.id === this.selectedSessionId);
    // Looking at a finished session counts as checking its output, but it stays
    // under "Ready to review" until the user moves on, so it doesn't jump away mid-read.
    if (selected && selected.unread && !isActive(selected) && this.isVisible()) {
      this.viewedUnread = selected.id;
    }
    const messages = this.selectedSessionId ? await this.api.getMessages(this.selectedSessionId) : [];
    const linkable = selected ? findLinkable(messages.map((m) => m.text), workDir(selected)) : [];
    const state: UiState = {
      layout: this.layout,
      providers,
      usage,
      sessions,
      selectedSessionId: this.selectedSessionId,
      messages,
      linkable,
      pastWindowMs: PAST_WINDOW_MS,
      showAllPast: this.showAllPast,
      keepAwake: keepAwakeSupported ? keepAwakeEnabled() : undefined,
      worktrees: this.gitRepo,
      now: Date.now(),
    };
    await this.post({ type: "state", state });
  }

  private async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready": {
        // Open on the most recent working session, never on an unread one.
        const sessions = await this.api.listSessions();
        const working = sessions.filter(isActive).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
        if (!this.selectedSessionId && working) this.select(working.id);
        await this.push();
        return;
      }
      case "selectSession":
        this.select(m.sessionId);
        await this.push();
        return;
      case "newSession":
        this.startNew();
        return;
      case "send": {
        let id = m.sessionId;
        if (!id) {
          const created = await this.api.createSession(m.options, workspaceCwd(), m.worktree);
          id = created.id;
          this.select(id);
        }
        await this.api.sendMessage(id, m.text, m.options, m.delivery);
        return;
      }
      case "removeQueued":
        await this.api.removeQueued(m.sessionId, m.queuedId);
        return;
      case "sendQueuedNow": {
        const session = (await this.api.listSessions()).find((s) => s.id === m.sessionId);
        const item = session && session.queued.find((q) => q.id === m.queuedId);
        if (!item) return;
        await this.api.removeQueued(m.sessionId, m.queuedId);
        await this.api.sendMessage(m.sessionId, item.text, undefined, "interrupt");
        return;
      }
      case "fork": {
        const fork = await this.api.forkSession(m.sessionId, m.messageId);
        this.select(fork.id);
        await this.push();
        return;
      }
      case "stop":
        await this.api.stopSession(m.sessionId);
        return;
      case "approve":
        await this.api.respondToApproval(m.sessionId, m.decision);
        return;
      case "complete":
        await this.api.archiveSession(m.sessionId);
        return;
      case "toggleAllPast":
        this.showAllPast = !this.showAllPast;
        await this.push();
        return;
      case "toggleKeepAwake":
        await vscode.workspace.getConfiguration("relay").update("keepAwake", !keepAwakeEnabled(), vscode.ConfigurationTarget.Global);
        return;
      case "setRunLimit":
        await this.askRunLimit(m.sessionId);
        return;
      case "openFile":
        await this.openFile(m.sessionId, m.path, m.line);
        return;
    }
  }

  /** Opens a file the chat mentions: beside the Relay tab, or in the active editor from the sidebar. */
  private async openFile(sessionId: string, file: string, line?: number): Promise<void> {
    const session = (await this.api.listSessions()).find((s) => s.id === sessionId);
    const uri = vscode.Uri.file(resolveIn(session ? workDir(session) : workspaceCwd(), file));
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showWarningMessage(`${file} doesn't exist.`);
      return;
    }
    if (stat.type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }
    const at = line ? new vscode.Position(line - 1, 0) : undefined;
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      viewColumn: this.layout === "wide" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      selection: at ? new vscode.Range(at, at) : undefined,
    };
    // vscode.open picks the right editor, so images and other non-text files open too.
    await vscode.commands.executeCommand("vscode.open", uri, options);
  }

  private async askRunLimit(sessionId: string): Promise<void> {
    const session = (await this.api.listSessions()).find((s) => s.id === sessionId);
    if (!session) return;
    const text = await vscode.window.showInputBox({
      title: "Time limit",
      prompt: "Stop the agent once a run has worked this long, e.g. 30m, 1h, 1h30m or 45 (minutes). Leave empty for no limit.",
      value: session.runLimitMs ? minutesLabel(session.runLimitMs) : "",
      validateInput: (v) => (v.trim() && !parseDuration(v) ? "Use minutes or hours, e.g. 30m, 1h or 1h30m." : undefined),
    });
    if (text === undefined) return;
    await this.api.setRunLimit(sessionId, text.trim() ? parseDuration(text) : undefined);
  }
}

export function keepAwakeEnabled(): boolean {
  return vscode.workspace.getConfiguration("relay").get<boolean>("keepAwake", true);
}

/** "45", "30m", "1h", "1.5h", "1h 30m" to milliseconds; undefined when unreadable or zero. */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)(?:m|min)?)?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return undefined;
  const ms = (parseFloat(m[1] || "0") * 60 + parseFloat(m[2] || "0")) * 60000;
  return ms > 0 ? Math.round(ms) : undefined;
}

export function workspaceCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : process.cwd();
}
