import type { Answers, Effort, MessageMode, ProviderId, ProviderInfo, Session, SessionOptions, TaskInput } from "../api/types";
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
  /** The next new session works in its own git worktree. Off until toggled; resets once used. */
  worktree: false,
  /** The next new session's agent may drive Relay's browser. Off until toggled; resets once used. */
  browser: false,
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

/** First usable provider's first model, for a brand-new session. */
export function defaultOptions(providers: ProviderInfo[]): { provider: ProviderId; model: string; effort: Effort } {
  const p = providers.find((x) => !x.unavailable && x.models.length);
  if (!p) return { provider: "claude", model: "default", effort: "high" };
  const m = p.models[0];
  return { provider: p.id, model: m.id, effort: m.defaultEffort || m.efforts[0] || "high" };
}

/** The composer follows the selected session's options until the user changes them. */
export function composerOptions(state: UiState): SessionOptions {
  const s = selected(state);
  if (!local.composer || local.composerFor !== state.selectedSessionId) {
    local.composerFor = state.selectedSessionId;
    local.composer = s ? { ...s.options } : defaultOptions(state.providers);
  }
  return local.composer;
}
