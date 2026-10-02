import type { Answers, ApprovalDecision, Delivery, Message, MessageMode, ModelSuggestion, ProviderId, ProviderInfo, ProviderUsage, ScheduledTask, Session, SessionInspect, SessionOptions, TaskInput } from "../api/types";

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
  /** Jev suggests a model for each message; undefined on the phone, which can't ask for the API key. */
  modelHints?: boolean;
  /** New sessions can work in a git worktree; false when the project isn't a git repo. */
  worktrees: boolean;
  /** This UI is on the phone: files can't be opened and there's no keyboard shortcut for everything. */
  remote: boolean;
  /** Remote access is on, which keeps the computer awake while agents work. */
  remoteAccess: boolean;
  /** Empty on the phone, which doesn't show scheduled tasks. */
  tasks: ScheduledTask[];
  /** The left column lists scheduled tasks instead of sessions, and the right one edits the selected task. */
  showScheduled: boolean;
  /** Task open in the form; undefined is a new one. */
  selectedTaskId?: string;
  /** The inspector takes the chat's place for the open session. */
  inspecting: boolean;
  /** The open session's inspector data, sent only while the inspector is up. */
  inspect?: SessionInspect;
  now: number;
}

export type ToWebview =
  | { type: "state"; state: UiState }
  | { type: "focusInput" }
  /** Added to the end of the message box, e.g. a note from the browser. */
  | { type: "insertText"; text: string }
  /** Fills the new-task form, e.g. from a session's messages. */
  | { type: "taskDraft"; draft: TaskInput }
  /** Files matching an @ search in the message box, answering the `searchFiles` with this `seq`. */
  | { type: "fileResults"; seq: number; paths: string[] }
  /** Answers the `suggestModel` with this `seq`; no suggestion when Jev couldn't give one. */
  | { type: "modelSuggestion"; seq: number; suggestion?: ModelSuggestion };

export type FromWebview =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession" }
  /** The title-bar buttons, repeated in the editor tab, which has no title bar of its own. */
  | { type: "openBrowser" }
  | { type: "toggleRemote" }
  | { type: "toggleScheduled" }
  /** Without an id, a new task. */
  | { type: "selectTask"; taskId?: string }
  /** Creates the task without an id; `runNow` also starts a run straight away. */
  | { type: "saveTask"; taskId?: string; task: TaskInput; runNow?: boolean }
  | { type: "pauseTask"; taskId: string; paused: boolean }
  | { type: "deleteTask"; taskId: string }
  /** Opens a new task drafted from the session's messages and options. */
  | { type: "scheduleSession"; sessionId: string }
  /** `browser` lets a new session's agent drive Relay's browser from its first turn. */
  | { type: "send"; sessionId?: string; text: string; options: SessionOptions; delivery: Delivery; worktree?: boolean; browser?: boolean; mode?: MessageMode }
  | { type: "toggleBrowserAccess"; sessionId: string }
  /** Swaps the chat for the session inspector, or back. */
  | { type: "toggleInspect" }
  | { type: "removeQueued"; sessionId: string; queuedId: string }
  | { type: "sendQueuedNow"; sessionId: string; queuedId: string }
  | { type: "fork"; sessionId: string; messageId?: string }
  /** Opens a subsession with the other provider, its first message drafted for the user to send. */
  | { type: "secondOpinion"; sessionId: string }
  | { type: "stop"; sessionId: string }
  | { type: "approve"; sessionId: string; decision: ApprovalDecision }
  /** Without answers the agent asks in a message instead. */
  | { type: "answer"; sessionId: string; answers?: Answers }
  | { type: "complete"; sessionId: string }
  | { type: "toggleAllPast" }
  | { type: "toggleKeepAwake" }
  /** Turning it on asks for the Jev API key if there isn't one yet. */
  | { type: "toggleModelHints" }
  /** The message being typed, for Jev to suggest a model in this provider. */
  | { type: "suggestModel"; seq: number; text: string; provider: ProviderId }
  /** Without a limit the extension asks for one; the phone sends what the user typed. */
  | { type: "setRunLimit"; sessionId: string; limit?: string }
  | { type: "openFile"; sessionId: string; path: string; line?: number }
  /** What's typed after an @ in the message box; files are searched in the session's folder, or the project's for a new one. */
  | { type: "searchFiles"; sessionId?: string; query: string; seq: number };
