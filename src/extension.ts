import * as path from "path";
import * as vscode from "vscode";
import { createMockSessionsApi } from "./api/MockSessionsApi";
import type { SessionsApi } from "./api/SessionsApi";
import type { Session } from "./api/types";
import { ClaudeAdapter } from "./backend/claude";
import { CodexAdapter } from "./backend/codex";
import { KeepAwake } from "./backend/keepAwake";
import { RealSessionsApi } from "./backend/RealSessionsApi";
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
