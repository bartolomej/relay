import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createMockSessionsApi } from "./api/MockSessionsApi";
import type { SessionsApi } from "./api/SessionsApi";
import { hasBackground, isActive, workDir, type MessageMode, type Session } from "./api/types";
import { ClaudeAdapter } from "./backend/claude";
import { CodexAdapter } from "./backend/codex";
import { KeepAwake } from "./backend/keepAwake";
import { RealSessionsApi } from "./backend/RealSessionsApi";
import { Scheduler } from "./backend/scheduler";
import { Browser, findChrome, type PageNote } from "./browser/browser";
import { resolveIn } from "./panel/fileLinks";
import { saveShot } from "./browser/shots";
import { SessionStore } from "./backend/store";
import { codexTitler } from "./backend/titles";
import { editorSelection, watchEditorSelection } from "./panel/editorSelection";
import { askForKey, initModelHints, modelHintsEnabled, setModelHints } from "./panel/modelHints";
import { keepAwakeEnabled, workspaceCwd } from "./panel/PanelHost";
import { SidebarViewProvider } from "./panel/SidebarViewProvider";
import { Attention, type NotifyLevel } from "./panel/attention";
import { WidePanel } from "./panel/WidePanel";
import { RemoteAccess } from "./remote/RemoteAccess";
import { remoteStatus } from "./remote/status";

const OLD_EXTENSION_ID = "gregorg.ai-sessions";

let remote: RemoteAccess | undefined;
/** Opens Relay's browser for an agent; set once the browser is registered. */
let openBrowserForAgent: (() => Promise<string>) | undefined;

function setting(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration("relay").get<string>(key);
  return value ? value : undefined;
}

/**
 * Sessions live in the project itself, one JSON file each in `.relay/sessions/`
 * of the first workspace folder, so each project sees only its own. With no
 * folder open they are kept in memory only.
 */
async function createStore(context: vscode.ExtensionContext): Promise<SessionStore> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  if (!folders.length) return new SessionStore();
  const store = new SessionStore(path.join(folders[0], ".relay", "sessions"), folders[0]);
  await store.load();
  if (store.sessions.size === 0) await importEarlierSessions(context, store, folders);
  return store;
}

/**
 * Sessions used to be kept in VS Code's storage, per workspace or in one global
 * file, under this extension's id or the old AI Sessions one. The first time a
 * project opens, its sessions from the first of those that has any move here.
 */
async function importEarlierSessions(context: vscode.ExtensionContext, store: SessionStore, folders: string[]): Promise<void> {
  const inWorkspace = (s: Session) => folders.some((f) => s.cwd === f || s.cwd.startsWith(f + path.sep));
  const files: string[] = [];
  for (const base of [context.storageUri, context.globalStorageUri]) {
    if (!base) continue;
    files.push(path.join(base.fsPath, "sessions.json"), path.join(path.dirname(base.fsPath), OLD_EXTENSION_ID, "sessions.json"));
  }
  for (const file of files) {
    if (await store.importSnapshot(file, inWorkspace)) return;
  }
}

/** Said before the output format text, so whatever is written there is read as a style for the reply, not as part of the task. */
const FORMAT_INTRO = "Write your reply in the following style. This is only about how to word and lay out the reply, not part of the task above:";

/** Added to the end of every message: the Plan or Ask instruction, then the output format if it's on. */
function instructions(mode: MessageMode): string {
  const modePrompt = mode === "normal" ? undefined : setting(mode === "plan" ? "planPrompt" : "askPrompt");
  const style = vscode.workspace.getConfiguration("relay").get("outputFormat", false) ? (setting("outputFormatPrompt") || "").trim() : "";
  const format = style ? `${FORMAT_INTRO}\n${style}` : undefined;
  return [modePrompt, format].map((p) => (p || "").trim()).filter(Boolean).join("\n\n");
}

async function createApi(context: vscode.ExtensionContext): Promise<SessionsApi> {
  if (setting("backend") === "mock") return createMockSessionsApi(workspaceCwd());
  const titler = codexTitler(() => setting("codexPath"), () => setting("titleModel") || "gpt-5.6-luna");
  return new RealSessionsApi(
    await createStore(context),
    [new ClaudeAdapter(() => setting("claudePath")), new CodexAdapter(() => setting("codexPath"))],
    titler,
    instructions,
    () => (openBrowserForAgent ? openBrowserForAgent() : Promise.reject(new Error("Relay's browser isn't ready yet."))),
  );
}

/** Scheduled tasks live next to the sessions, in `.relay/schedules.json`; the mock keeps them in memory. */
function createScheduler(api: SessionsApi): Scheduler {
  const folders = vscode.workspace.workspaceFolders || [];
  const file = setting("backend") !== "mock" && folders.length ? path.join(folders[0].uri.fsPath, ".relay", "schedules.json") : undefined;
  return new Scheduler(api, workspaceCwd(), file);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api = await createApi(context);
  context.subscriptions.push({ dispose: () => api.dispose() });

  watchKeepAwake(context, api);
  initModelHints(context, () => api.listProviders());

  const scheduler = createScheduler(api);
  context.subscriptions.push({ dispose: () => scheduler.dispose() });
  await scheduler.start();

  const sidebar = new SidebarViewProvider(context.extensionUri, api, scheduler);
  registerBrowser(context, api, sidebar);
  registerRemote(context, api);

  const attention = new Attention(api, {
    // Selected in a visible panel of the focused window: the user is already looking.
    isViewing: (id) => vscode.window.state.focused && (sidebar.isViewing(id) || WidePanel.isViewing(id)),
    open: (id) => {
      if (!WidePanel.open(id)) void sidebar.open(id);
    },
    setBadge: (badge) => sidebar.setBadge(badge),
    level: () => vscode.workspace.getConfiguration("relay").get<NotifyLevel>("notifications", "all"),
  });

  // One click from the status bar opens Relay as an editor tab.
  const launcher = vscode.window.createStatusBarItem("relay.launcher", vscode.StatusBarAlignment.Left, 100);
  launcher.name = "Relay";
  launcher.text = "$(comment-discussion) Relay";
  launcher.tooltip = "Open Relay as an editor tab";
  launcher.command = "relay.openAsTab";
  launcher.show();

  context.subscriptions.push(
    launcher,
    watchEditorSelection(workspaceCwd),
    attention,
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("relay.openAsTab", () => WidePanel.show(context.extensionUri, api, scheduler)),
    vscode.commands.registerCommand("relay.newSession", () => {
      if (!WidePanel.startNew()) sidebar.startNew();
    }),
    vscode.commands.registerCommand("relay.setJevKey", () => askForKey()),
    // Like Cursor's Add to Chat: the selection goes with the next message, next to any added before it.
    vscode.commands.registerCommand("relay.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editorSelection.pin(editor, workspaceCwd())) {
        void vscode.window.showInformationMessage("Select some code in a file first.");
        return;
      }
      if (!WidePanel.focusInput()) await sidebar.focusInput();
    }),
    vscode.commands.registerCommand("relay.toggleModelHints", () => setModelHints(!modelHintsEnabled())),
    vscode.commands.registerCommand("relay.settings", () => {
      if (!WidePanel.toggleSettings()) void sidebar.toggleSettings();
    }),
    vscode.commands.registerCommand("relay.scheduledTasks", () => {
      if (!WidePanel.toggleScheduled()) sidebar.toggleScheduled();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("relay.backend")) {
        void vscode.window.showInformationMessage("Reload the window to switch the Relay backend.", "Reload").then((pick) => {
          if (pick) void vscode.commands.executeCommand("workbench.action.reloadWindow");
        });
      }
    }),
  );

  // Last, so the browser and everything else a turn may need is in place.
  api.resumeInterrupted();
}

/**
 * Relay's own Chrome window. Picking an element there and writing a note adds
 * it to a chat's message box, in the Relay tab if one is open, else the sidebar.
 */
function registerBrowser(context: vscode.ExtensionContext, api: SessionsApi, sidebar: SidebarViewProvider): void {
  const storage = context.storageUri || context.globalStorageUri;
  const selectedSession = () => (WidePanel.selectedSession() !== undefined ? WidePanel.selectedSession() : sidebar.selectedSession());
  const browser = new Browser(path.join(storage.fsPath, "chrome"), {
    pickerSource: () => fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, "dist", "picker.js").fsPath, "utf8"),
    targets: async () => {
      const sessions = (await api.listSessions()).filter((s) => !s.archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      return { targets: sessions.map((s) => ({ id: s.id, title: s.title })), selected: selectedSession() };
    },
    addNote: async (note) => {
      const session = (await api.listSessions()).find((s) => s.id === note.sessionId);
      const id = session ? session.id : undefined;
      if (!WidePanel.insertText(id, formatNote(note))) await sidebar.insertText(id, formatNote(note));
      return session ? `“${session.title}”` : "a new chat";
    },
    // Next to the sessions, where the agents can open them.
    saveScreenshot: (png) => saveShot(path.join(workspaceCwd(), ".relay", "shots"), png),
  });
  // An agent with browser access gets the browser on the project's app, or a blank tab to navigate from.
  openBrowserForAgent = () => {
    const executable = findChrome(setting("chromePath"));
    if (!executable) return Promise.reject(new Error("it needs Google Chrome. Install it, or set relay.chromePath to a Chromium browser."));
    return browser.agentEndpoint(context.workspaceState.get<string>("relay.browserUrl", "about:blank"), executable);
  };
  context.subscriptions.push(
    { dispose: () => browser.dispose() },
    vscode.commands.registerCommand("relay.openBrowser", async () => {
      const url = await askUrl(context);
      if (url) await openUrl(url);
    }),
    // An HTML file a chat links to, from ⌘-click or the link's right-click menu.
    vscode.commands.registerCommand("relay.openFileInBrowser", async (link?: { sessionId?: string; path?: string }) => {
      if (!link || !link.path) return;
      const session = (await api.listSessions()).find((s) => s.id === link.sessionId);
      await openUrl(vscode.Uri.file(resolveIn(session ? workDir(session) : workspaceCwd(), link.path)).toString());
    }),
  );

  async function openUrl(url: string): Promise<void> {
    const executable = findChrome(setting("chromePath"));
    if (!executable) {
      void vscode.window.showErrorMessage("Open in Browser needs Google Chrome. Install it, or set relay.chromePath to a Chromium browser.");
      return;
    }
    try {
      await browser.open(url, executable);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }
}

/** The app's address, remembered per project. A bare host like localhost:3000 gets http://. */
async function askUrl(context: vscode.ExtensionContext): Promise<string | undefined> {
  const normalize = (v: string) => (/^[a-z][a-z0-9+.-]*:/i.test(v.trim()) ? v.trim() : `http://${v.trim()}`);
  const text = await vscode.window.showInputBox({
    title: "Open in Browser",
    prompt: "Address of the app. In the browser, the ✎ button (or ⌥⇧C) picks an element and adds your note to a chat.",
    value: context.workspaceState.get<string>("relay.browserUrl", "http://localhost:3000"),
    validateInput: (v) => (/^https?:\/\/\S+$/i.test(normalize(v)) ? undefined : "Enter an address like localhost:3000 or https://example.com."),
  });
  if (!text) return undefined;
  const url = normalize(text);
  await context.workspaceState.update("relay.browserUrl", url);
  return url;
}

/**
 * What lands in the message box. The element's text helps the agent find it in
 * the source; the screenshot, errors and failed requests show it what the user saw.
 */
function formatNote(note: PageNote): string {
  const lines = [`Page: ${note.url}`, `Element: ${note.selector}`];
  if (note.text) lines.push(`Element text: "${note.text}"`);
  if (note.viewport) lines.push(`Viewport: ${note.viewport}`);
  if (note.screenshot) lines.push(`Screenshot of the element: ${note.screenshot}`);
  if (note.errors) lines.push("Console errors on the page:", ...note.errors.map((e) => `- ${e}`));
  if (note.failedRequests) lines.push("Failed requests:", ...note.failedRequests.map((r) => `- ${r}`));
  lines.push(`Note: ${note.comment}`);
  return lines.join("\n");
}

/** The Remote button, off until clicked in each window. */
function registerRemote(context: vscode.ExtensionContext, api: SessionsApi): void {
  const access = new RemoteAccess(context, api, () => setting("tailscalePath"));
  remote = access;
  const run = (what: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  context.subscriptions.push(
    access,
    vscode.commands.registerCommand(
      "relay.remoteOn",
      run("turn on remote access", () =>
        Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Turning on remote access…" }, () => access.turnOn())),
      ),
    ),
    vscode.commands.registerCommand("relay.remoteOff", run("turn off remote access", () => access.turnOff())),
    vscode.commands.registerCommand("relay.remoteResetKey", run("reset the remote access key", () => access.resetKey())),
  );
}

/**
 * Holds the computer awake while any session is running, background work
 * included, unless turned off.
 * With Remote on it always does, and also while a session waits for an
 * approval, since the phone can only answer while the computer is awake.
 */
function watchKeepAwake(context: vscode.ExtensionContext, api: SessionsApi): void {
  const keepAwake = new KeepAwake();
  let queued = false;
  // Changes fire on every streamed token; checking twice a second is plenty.
  const update = () => {
    if (queued) return;
    queued = true;
    setTimeout(async () => {
      queued = false;
      const sessions = await api.listSessions();
      if (remoteStatus.on) keepAwake.set(sessions.some((s) => isActive(s) || hasBackground(s)));
      else keepAwake.set(sessions.some((s) => s.status === "running" || hasBackground(s)) && keepAwakeEnabled());
    }, 500);
  };
  const unsubscribe = api.onDidChange(update);
  context.subscriptions.push(
    keepAwake,
    { dispose: unsubscribe },
    remoteStatus.onDidChange(update),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("relay.keepAwake")) update();
    }),
  );
}

/** Undoes `tailscale serve`, so the address doesn't point at a closed window. */
export async function deactivate(): Promise<void> {
  if (remote) await remote.turnOff();
}
