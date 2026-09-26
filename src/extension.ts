import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createMockSessionsApi } from "./api/MockSessionsApi";
import type { SessionsApi } from "./api/SessionsApi";
import type { Session } from "./api/types";
import { ClaudeAdapter } from "./backend/claude";
import { CodexAdapter } from "./backend/codex";
import { KeepAwake } from "./backend/keepAwake";
import { RealSessionsApi } from "./backend/RealSessionsApi";
import { Browser, findChrome, type PageNote } from "./browser/browser";
import { SessionStore } from "./backend/store";
import { codexTitler } from "./backend/titles";
import { keepAwakeEnabled, workspaceCwd } from "./panel/PanelHost";
import { SidebarViewProvider } from "./panel/SidebarViewProvider";
import { Attention, type NotifyLevel } from "./panel/attention";
import { WidePanel } from "./panel/WidePanel";

const OLD_EXTENSION_ID = "gregorg.ai-sessions";

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

async function createApi(context: vscode.ExtensionContext): Promise<SessionsApi> {
  if (setting("backend") === "mock") return createMockSessionsApi(workspaceCwd());
  const titler = codexTitler(() => setting("codexPath"), () => setting("titleModel") || "gpt-5.6-luna");
  return new RealSessionsApi(
    await createStore(context),
    [new ClaudeAdapter(() => setting("claudePath")), new CodexAdapter(() => setting("codexPath"))],
    titler,
    (mode) => (mode === "normal" ? "" : setting(mode === "plan" ? "planPrompt" : "askPrompt") || ""),
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api = await createApi(context);
  context.subscriptions.push({ dispose: () => api.dispose() });

  watchKeepAwake(context, api);

  const sidebar = new SidebarViewProvider(context.extensionUri, api);
  registerBrowser(context, api, sidebar);

  const attention = new Attention(api, {
    // Selected in a visible panel of the focused window: the user is already looking.
    isViewing: (id) => vscode.window.state.focused && (sidebar.isViewing(id) || WidePanel.isViewing(id)),
    open: (id) => {
      if (!WidePanel.open(id)) void sidebar.open(id);
    },
    setBadge: (badge) => sidebar.setBadge(badge),
    level: () => vscode.workspace.getConfiguration("relay").get<NotifyLevel>("notifications", "all"),
  });

  context.subscriptions.push(
    attention,
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("relay.openAsTab", () => WidePanel.show(context.extensionUri, api)),
    vscode.commands.registerCommand("relay.newSession", () => {
      if (!WidePanel.startNew()) sidebar.startNew();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("relay.backend")) {
        void vscode.window.showInformationMessage("Reload the window to switch the Relay backend.", "Reload").then((pick) => {
          if (pick) void vscode.commands.executeCommand("workbench.action.reloadWindow");
        });
      }
    }),
  );
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
  });
  context.subscriptions.push(
    { dispose: () => browser.dispose() },
    vscode.commands.registerCommand("relay.openBrowser", async () => {
      const executable = findChrome(setting("chromePath"));
      if (!executable) {
        void vscode.window.showErrorMessage("Open in Browser needs Google Chrome. Install it, or set relay.chromePath to a Chromium browser.");
        return;
      }
      const url = await askUrl(context);
      if (!url) return;
      try {
        await browser.open(url, executable);
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),
  );
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

/** What lands in the message box; the element's text helps the agent find it in the source. */
function formatNote(note: PageNote): string {
  const lines = [`Page: ${note.url}`, `Element: ${note.selector}`];
  if (note.text) lines.push(`Element text: "${note.text}"`);
  lines.push(`Note: ${note.comment}`);
  return lines.join("\n");
}

/** Holds the computer awake while any session is running, unless turned off. */
function watchKeepAwake(context: vscode.ExtensionContext, api: SessionsApi): void {
  const keepAwake = new KeepAwake();
  let queued = false;
  // Changes fire on every streamed token; checking twice a second is plenty.
  const update = () => {
    if (queued) return;
    queued = true;
    setTimeout(async () => {
      queued = false;
      const running = (await api.listSessions()).some((s) => s.status === "running");
      keepAwake.set(running && keepAwakeEnabled());
    }, 500);
  };
  const unsubscribe = api.onDidChange(update);
  context.subscriptions.push(
    keepAwake,
    { dispose: unsubscribe },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("relay.keepAwake")) update();
    }),
  );
}

export function deactivate(): void {}
