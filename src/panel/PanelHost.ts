import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import { DEFAULT_RUN_LIMIT_MS, DEFAULT_SCHEDULE, taskName } from "../api/schedule";
import { isActive, minutesLabel, workDir, type Answers, type ProviderId, type TaskInput } from "../api/types";
import { keepAwakeSupported } from "../backend/keepAwake";
import { cleanTaskInput, type Scheduler } from "../backend/scheduler";
import { isGitRepo } from "../backend/worktree";
import { remoteStatus } from "../remote/status";
import { findLinkable, resolveIn } from "./fileLinks";
import { searchFiles } from "./fileSearch";
import { modelHintsEnabled, setModelHints, suggestModel } from "./modelHints";
import { secondOpinionDraft } from "./secondOpinion";
import type { FromWebview, Layout, ToWebview, UiState } from "./protocol";

const PAST_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Where a PanelHost's UI lives: a VS Code webview, or the phone over the network. */
export interface UiChannel {
  post(msg: ToWebview): Thenable<unknown>;
  onMessage(listener: (m: FromWebview) => void): vscode.Disposable;
}

export function webviewChannel(webview: vscode.Webview): UiChannel {
  return { post: (msg) => webview.postMessage(msg), onMessage: (listener) => webview.onDidReceiveMessage(listener) };
}

/**
 * Glue between one UI and the SessionsApi. The sidebar view, the editor-tab
 * panel and each connected phone own one of these; the API is shared.
 */
export class PanelHost implements vscode.Disposable {
  private selectedSessionId: string | undefined;
  /** Unread session the user has looked at; marked seen once they select something else. */
  private viewedUnread: string | undefined;
  private showAllPast = false;
  private showScheduled = false;
  /** The inspector is up in place of the chat; picking another session closes it. */
  private inspecting = false;
  private selectedTaskId: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private pushQueued = false;
  private gitRepo = false;

  /**
   * @param remote the UI is on the phone: looking at a session there never marks it
   *   reviewed, files can't be opened, and state is pushed less often to spare the network
   */
  constructor(
    private readonly channel: UiChannel,
    private readonly api: SessionsApi,
    /** Undefined on the phone, which doesn't show scheduled tasks. */
    private readonly scheduler: Scheduler | undefined,
    private readonly layout: Layout,
    private readonly isVisible: () => boolean,
    private readonly remote = false,
  ) {
    this.disposables.push(channel.onMessage((m) => void this.handle(m)));
    void isGitRepo(workspaceCwd()).then((yes) => {
      this.gitRepo = yes;
      this.schedulePush();
    });
    const unsubscribe = api.onDidChange(() => this.schedulePush());
    this.disposables.push({ dispose: unsubscribe });
    if (scheduler) this.disposables.push({ dispose: scheduler.onDidChange(() => this.schedulePush()) });
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("relay.keepAwake") || e.affectsConfiguration("relay.modelHints")) this.schedulePush();
      }),
      remoteStatus.onDidChange(() => this.schedulePush()),
    );
  }

  dispose(): void {
    this.select(undefined);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Clears the selection so the next message starts a new session. */
  startNew(): void {
    this.showScheduled = false;
    this.select(undefined);
    void this.push().then(() => this.post({ type: "focusInput" }));
  }

  /** Shows this session, e.g. from a notification's Open button. */
  open(sessionId: string): void {
    this.showScheduled = false;
    this.select(sessionId);
    void this.push();
  }

  /** Opens the session, or a new one without an id, and adds the text to the message box for the user to send. */
  insertText(sessionId: string | undefined, text: string): void {
    this.showScheduled = false;
    this.select(sessionId);
    void this.push().then(() => this.post({ type: "insertText", text }));
  }

  /** Switches between the sessions and the scheduled tasks. */
  toggleScheduled(): void {
    if (!this.scheduler) return;
    this.showScheduled = !this.showScheduled;
    void this.push();
  }

  get selectedSession(): string | undefined {
    return this.selectedSessionId;
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
    if (this.selectedSessionId !== id) this.inspecting = false;
    this.selectedSessionId = id;
  }

  private post(msg: ToWebview): Thenable<unknown> {
    return this.channel.post(msg);
  }

  private schedulePush(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setTimeout(() => {
      this.pushQueued = false;
      void this.push();
    }, this.remote ? 300 : 40);
  }

  private async push(): Promise<void> {
    const [providers, usage, sessions] = await Promise.all([this.api.listProviders(), this.api.getUsage(), this.api.listSessions()]);
    if (this.selectedSessionId && !sessions.some((s) => s.id === this.selectedSessionId)) {
      this.selectedSessionId = undefined;
    }
    const selected = sessions.find((s) => s.id === this.selectedSessionId);
    // Looking at a finished session counts as checking its output, but it stays
    // under "Ready to review" until the user moves on, so it doesn't jump away mid-read.
    // On the phone it's only a peek; the user reviews on the laptop or with Complete.
    if (selected && selected.unread && !isActive(selected) && this.isVisible() && !this.remote) {
      this.viewedUnread = selected.id;
    }
    const tasks = this.scheduler ? this.scheduler.list() : [];
    if (this.selectedTaskId && !tasks.some((t) => t.id === this.selectedTaskId)) this.selectedTaskId = undefined;
    const messages = this.selectedSessionId ? await this.api.getMessages(this.selectedSessionId) : [];
    const linkable = selected && !this.remote ? findLinkable(messages.map((m) => m.text), workDir(selected)) : [];
    const inspect = this.inspecting && this.selectedSessionId ? await this.api.getInspect(this.selectedSessionId) : undefined;
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
      modelHints: this.remote ? undefined : modelHintsEnabled(),
      worktrees: this.gitRepo,
      remote: this.remote,
      remoteAccess: remoteStatus.on,
      tasks,
      showScheduled: this.showScheduled,
      selectedTaskId: this.selectedTaskId,
      inspecting: this.inspecting,
      inspect,
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
        this.showScheduled = false;
        this.select(m.sessionId);
        await this.push();
        return;
      case "newSession":
        this.startNew();
        return;
      case "openBrowser":
        if (!this.remote) await vscode.commands.executeCommand("relay.openBrowser");
        return;
      case "toggleRemote":
        // The phone can't turn Remote off; it would cut itself off.
        if (!this.remote) await vscode.commands.executeCommand(remoteStatus.on ? "relay.remoteOff" : "relay.remoteOn");
        return;
      case "toggleScheduled":
        this.toggleScheduled();
        return;
      case "selectTask":
        // Also from a run's Scheduled tag, which is on the sessions side.
        if (!this.scheduler) return;
        this.showScheduled = true;
        this.selectedTaskId = m.taskId;
        await this.push();
        return;
      case "saveTask":
        await this.saveTask(m.taskId, m.task, !!m.runNow);
        return;
      case "pauseTask":
        if (this.scheduler) await this.scheduler.setPaused(m.taskId, m.paused);
        return;
      case "deleteTask":
        await this.deleteTask(m.taskId);
        return;
      case "scheduleSession":
        await this.scheduleSession(m.sessionId);
        return;
      case "send": {
        let id = m.sessionId;
        if (!id) {
          const created = await this.api.createSession(m.options, workspaceCwd(), m.worktree);
          id = created.id;
          this.select(id);
          if (m.browser) await this.api.setBrowserAccess(id, true);
        }
        await this.api.sendMessage(id, m.text, m.options, m.delivery, m.mode);
        return;
      }
      case "removeQueued":
        await this.api.removeQueued(m.sessionId, m.queuedId);
        return;
      case "toggleBrowserAccess": {
        const session = (await this.api.listSessions()).find((s) => s.id === m.sessionId);
        if (session) await this.api.setBrowserAccess(session.id, !session.browserAccess);
        return;
      }
      case "toggleInspect":
        this.inspecting = !this.inspecting && !!this.selectedSessionId;
        await this.push();
        return;
      case "sendQueuedNow": {
        const session = (await this.api.listSessions()).find((s) => s.id === m.sessionId);
        const item = session && session.queued.find((q) => q.id === m.queuedId);
        if (!item) return;
        await this.api.removeQueued(m.sessionId, m.queuedId);
        await this.api.sendMessage(m.sessionId, item.text, undefined, "interrupt", item.mode);
        return;
      }
      case "fork": {
        const fork = await this.api.forkSession(m.sessionId, m.messageId);
        this.select(fork.id);
        await this.push();
        return;
      }
      case "secondOpinion":
        await this.secondOpinion(m.sessionId);
        return;
      case "stop":
        await this.api.stopSession(m.sessionId);
        return;
      case "approve":
        await this.api.respondToApproval(m.sessionId, m.decision);
        return;
      case "answer":
        await this.api.answerQuestions(m.sessionId, cleanAnswers(m.answers));
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
      case "toggleModelHints":
        if (!this.remote) await setModelHints(!modelHintsEnabled());
        return;
      case "suggestModel":
        if (!this.remote) await this.suggestModel(m.seq, m.text, m.provider);
        return;
      case "setRunLimit":
        if (m.limit === undefined) await this.askRunLimit(m.sessionId);
        else await this.setRunLimit(m.sessionId, m.limit);
        return;
      case "openFile":
        if (!this.remote) await this.openFile(m.sessionId, m.path, m.line);
        return;
      case "searchFiles":
        if (!this.remote) await this.searchFiles(m.sessionId, m.query, m.seq);
        return;
    }
  }

  private async suggestModel(seq: number, text: string, providerId: ProviderId): Promise<void> {
    const provider = modelHintsEnabled() ? (await this.api.listProviders()).find((p) => p.id === providerId) : undefined;
    const suggestion = provider ? await suggestModel(text, provider) : undefined;
    await this.post({ type: "modelSuggestion", seq, suggestion });
  }

  private async searchFiles(sessionId: string | undefined, query: string, seq: number): Promise<void> {
    const session = sessionId ? (await this.api.listSessions()).find((s) => s.id === sessionId) : undefined;
    const paths = await searchFiles(session ? workDir(session) : workspaceCwd(), query, 30);
    await this.post({ type: "fileResults", seq, paths });
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

  /** Saves the form; running it now shows the new session, for trying a prompt out. */
  private async saveTask(taskId: string | undefined, input: unknown, runNow: boolean): Promise<void> {
    const task = cleanTaskInput(input);
    if (!this.scheduler || !task) return;
    const saved = await this.scheduler.save(taskId, task);
    this.selectedTaskId = saved.id;
    const sessionId = runNow ? await this.scheduler.runNow(saved.id) : undefined;
    if (sessionId) {
      this.showScheduled = false;
      this.select(sessionId);
    }
    await this.push();
  }

  private async deleteTask(taskId: string): Promise<void> {
    const task = this.scheduler && this.scheduler.list().find((t) => t.id === taskId);
    if (!this.scheduler || !task) return;
    const pick = await vscode.window.showWarningMessage(
      `Delete the scheduled task “${taskName(task)}”?`,
      { modal: true, detail: "Sessions it already started stay." },
      "Delete",
    );
    if (pick) await this.scheduler.remove(taskId);
  }

  /** A new task with the session's requests as its prompt, oldest first, for the user to trim into one. */
  private async scheduleSession(sessionId: string): Promise<void> {
    const session = (await this.api.listSessions()).find((s) => s.id === sessionId);
    if (!this.scheduler || !session) return;
    const asked = (await this.api.getMessages(sessionId)).filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text.trim());
    const draft: TaskInput = {
      name: session.title,
      prompt: asked.join("\n\n"),
      options: { ...session.options },
      schedule: { ...DEFAULT_SCHEDULE },
      useWorktree: this.gitRepo,
      runLimitMs: DEFAULT_RUN_LIMIT_MS,
    };
    this.showScheduled = true;
    this.selectedTaskId = undefined;
    await this.push();
    await this.post({ type: "taskDraft", draft });
  }

  /** A subsession with the other provider's default model; the drafted message waits for the user to send it. */
  private async secondOpinion(sessionId: string): Promise<void> {
    const [sessions, providers] = await Promise.all([this.api.listSessions(), this.api.listProviders()]);
    const parent = sessions.find((s) => s.id === sessionId);
    const other = parent && providers.find((p) => p.id !== parent.options.provider && !p.unavailable && p.models.length);
    if (!parent || !other) return;
    const model = other.models[0];
    const options = { provider: other.id, model: model.id, effort: model.defaultEffort || model.efforts[0] || "high" };
    const child = await this.api.createSubsession(parent.id, options, `Second opinion on ${parent.title}`);
    this.insertText(child.id, secondOpinionDraft(parent, await this.api.getMessages(parent.id)));
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
    await this.setRunLimit(sessionId, text);
  }

  /** Typed on the phone, where there's no input box; an unreadable limit changes nothing. */
  private async setRunLimit(sessionId: string, text: string): Promise<void> {
    const ms = parseDuration(text);
    if (text.trim() && !ms) return;
    await this.api.setRunLimit(sessionId, ms);
  }
}

/** Answers can come from the phone, so only lists of text get through to the agent. */
function cleanAnswers(answers: unknown): Answers | undefined {
  if (!answers || typeof answers !== "object") return undefined;
  const out: Answers = {};
  for (const [id, picked] of Object.entries(answers)) {
    if (Array.isArray(picked)) out[id] = picked.filter((a): a is string => typeof a === "string");
  }
  return out;
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
