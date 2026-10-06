import type { Answers, Effort, MessageMode, ProviderId, Session, SessionOptions, TaskInput } from "../api/types";
import type { FromWebview, UiState } from "../panel/protocol";

import { connectRemote } from "./remote";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

/** Inside VS Code the webview API; on the phone, the network. */
const send: (m: FromWebview) => void =
  typeof acquireVsCodeApi === "function"
    ? (() => {
        const vscode = acquireVsCodeApi();
        return (m: FromWebview) => vscode.postMessage(m);
      })()
    : connectRemote();

export function post(m: FromWebview): void {
  send(m);
}

/** Local UI state that survives state pushes from the extension host. */
export const local = {
  /** Unset until toggled: open in the editor tab, collapsed in the narrow sidebar. */
  usageOpen: undefined as boolean | undefined,
  /** What's typed in the Past search, while all past sessions are shown. */
  pastQuery: "",
  /** Pinned user message the user clicked open. */
  expandedPin: undefined as string | undefined,
  composer: undefined as SessionOptions | undefined,
  composerFor: undefined as string | undefined,
  /** Text typed but not sent, by session id ("" for a new session). */
  drafts: {} as Record<string, string>,
  /** The next new session works in its own git worktree. Unset follows `relay.newSessionWorktree`; resets once used. */
  worktree: undefined as boolean | undefined,
  /** The next new session's agent may drive Relay's browser. Unset follows `relay.newSessionBrowser`; resets once used. */
  browser: undefined as boolean | undefined,
  /** The editor selection the user removed from the message box, or already sent, so it isn't offered again until it changes. */
  usedSelection: "",
  /** How the next message is sent. Plan goes back to normal after each send; ask stays until switched. */
  mode: "normal" as MessageMode,
  /** Options picked so far for a session's pending questions, by session id. */
  picks: {} as Record<string, Answers>,
  /** Answers typed so far for them, by session id and question id. */
  typed: {} as Record<string, Record<string, string>>,
  /** The scheduled-task form as edited so far, and which task it's for ("new" for a new one). */
  taskForm: undefined as TaskInput | undefined,
  taskFormFor: undefined as string | undefined,
  /** The form has edits that aren't saved yet. */
  taskDirty: false,
};

export function selected(state: UiState): Session | undefined {
  return state.sessions.find((s) => s.id === state.selectedSessionId);
}

/**
 * What a brand-new session starts with: `relay.newSessionModel` while its
 * provider is usable and lists the model, else the first usable provider's first model.
 */
export function defaultOptions(state: UiState): { provider: ProviderId; model: string; effort: Effort } {
  const want = state.newSession.options || {};
  const preferred = state.providers.find((x) => x.id === want.provider && !x.unavailable);
  const pm = preferred && preferred.models.find((m) => m.id === want.model);
  if (preferred && pm) {
    const effort = want.effort && pm.efforts.includes(want.effort) ? want.effort : pm.defaultEffort || pm.efforts[0] || "high";
    return { provider: preferred.id, model: pm.id, effort };
  }
  const p = state.providers.find((x) => !x.unavailable && x.models.length);
  if (!p) return { provider: "claude", model: "default", effort: "high" };
  const m = p.models[0];
  return { provider: p.id, model: m.id, effort: m.defaultEffort || m.efforts[0] || "high" };
}

/** Whether the next new session gets a worktree: as toggled, else the setting. */
export function newWorktree(state: UiState): boolean {
  return state.worktrees && (local.worktree !== undefined ? local.worktree : state.newSession.worktree);
}

/** Whether the next new session's agent may use the browser: as toggled, else the setting. */
export function newBrowser(state: UiState): boolean {
  return local.browser !== undefined ? local.browser : state.newSession.browser;
}

/** The composer follows the selected session's options until the user changes them. */
export function composerOptions(state: UiState): SessionOptions {
  const s = selected(state);
  if (!local.composer || local.composerFor !== state.selectedSessionId) {
    local.composerFor = state.selectedSessionId;
    local.composer = s ? { ...s.options } : defaultOptions(state);
  }
  return local.composer;
}
