import type { ApprovalDecision, Delivery, Message, MessageMode, ProviderInfo, ProviderUsage, Session, SessionOptions } from "../api/types";

export type Layout = "sidebar" | "wide";

/** Full snapshot pushed to the webview after every change. */
export interface UiState {
  layout: Layout;
  providers: ProviderInfo[];
  usage: ProviderUsage[];
  sessions: Session[];
  selectedSessionId?: string;
  messages: Message[];
  /** Path-like strings in the open session's messages that exist on disk, so they render as file links. */
  linkable: string[];
  /** Past sessions active within this window are listed without expanding. */
  pastWindowMs: number;
  /** Also list older and completed sessions. */
  showAllPast: boolean;
  /** Keep the computer awake while an agent works; undefined where that isn't supported. */
  keepAwake?: boolean;
  /** New sessions can work in a git worktree; false when the project isn't a git repo. */
  worktrees: boolean;
  /** This UI is on the phone: files can't be opened and there's no keyboard shortcut for everything. */
  remote: boolean;
  /** Remote access is on, which keeps the computer awake while agents work. */
  remoteAccess: boolean;
  now: number;
}

export type ToWebview =
  | { type: "state"; state: UiState }
  | { type: "focusInput" }
  /** Added to the end of the message box, e.g. a note from the browser. */
  | { type: "insertText"; text: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession" }
  | { type: "send"; sessionId?: string; text: string; options: SessionOptions; delivery: Delivery; worktree?: boolean; mode?: MessageMode }
  | { type: "removeQueued"; sessionId: string; queuedId: string }
  | { type: "sendQueuedNow"; sessionId: string; queuedId: string }
  | { type: "fork"; sessionId: string; messageId?: string }
  | { type: "stop"; sessionId: string }
  | { type: "approve"; sessionId: string; decision: ApprovalDecision }
  | { type: "complete"; sessionId: string }
  | { type: "toggleAllPast" }
  | { type: "toggleKeepAwake" }
  /** Without a limit the extension asks for one; the phone sends what the user typed. */
  | { type: "setRunLimit"; sessionId: string; limit?: string }
  | { type: "openFile"; sessionId: string; path: string; line?: number };
