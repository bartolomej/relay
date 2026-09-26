import type { Effort, ProviderId, ProviderInfo, Session, SessionOptions } from "../api/types";
import type { FromWebview, UiState } from "../panel/protocol";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

const vscode = acquireVsCodeApi();

export function post(m: FromWebview): void {
  vscode.postMessage(m);
}

/** Local UI state that survives state pushes from the extension host. */
export const local = {
  /** Unset until toggled: open in the editor tab, collapsed in the narrow sidebar. */
  usageOpen: undefined as boolean | undefined,
  /** Pinned user message the user clicked open. */
  expandedPin: undefined as string | undefined,
  composer: undefined as SessionOptions | undefined,
  composerFor: undefined as string | undefined,
  /** The next new session works in its own git worktree. Off until toggled; resets once used. */
  worktree: false,
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
