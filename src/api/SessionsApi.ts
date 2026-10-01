import type { Answers, ApprovalDecision, Delivery, Message, MessageMode, ProviderInfo, ProviderUsage, Session, SessionInspect, SessionOptions } from "./types";

export type Unsubscribe = () => void;

/**
 * Everything the UI needs from the backend. The mock implements this today;
 * the real implementation will sit on top of the Claude Agent SDK, the Codex
 * SDK or pi's RPC mode without the UI changing.
 */
export interface SessionsApi {
  listProviders(): Promise<ProviderInfo[]>;

  /**
   * Plan usage limits per provider. Real sources: Claude's get_usage control
   * request and rate_limit_event, Codex app-server's account/rateLimits/read and
   * account/rateLimits/updated. Only available with a subscription login.
   */
  getUsage(): Promise<ProviderUsage[]>;

  listSessions(): Promise<Session[]>;
  getMessages(sessionId: string): Promise<Message[]>;
  /** How the session was set up and how it ran, for the inspector. Undefined until a Claude turn reports it. */
  getInspect(sessionId: string): Promise<SessionInspect | undefined>;

  /**
   * With `useWorktree`, the agent works in a git worktree created on the first
   * message. `scheduledTaskId` tags a session a scheduled task started.
   */
  createSession(options: SessionOptions, cwd: string, useWorktree?: boolean, scheduledTaskId?: string): Promise<Session>;
  /**
   * Sends right away when the session is idle. While it's working, "queue"
   * holds the message until the turn ends and "interrupt" stops the turn first.
   * Also brings an archived session (and its ancestors) back. The mode is kept
   * with a queued message and applied when it's sent.
   */
  sendMessage(sessionId: string, text: string, options?: Partial<SessionOptions>, delivery?: Delivery, mode?: MessageMode): Promise<void>;
  removeQueued(sessionId: string, queuedId: string): Promise<void>;
  forkSession(sessionId: string, fromMessageId?: string): Promise<Session>;
  /**
   * A new conversation nested under the parent, working in the same folder or
   * worktree, e.g. another provider giving a second opinion. Starts empty.
   */
  createSubsession(parentId: string, options: SessionOptions, title: string): Promise<Session>;
  /** Stops the running turn; on an idle session, the work its agent left running in the background. */
  stopSession(sessionId: string): Promise<void>;
  respondToApproval(sessionId: string, decision: ApprovalDecision): Promise<void>;
  /** Without answers the agent is told to ask in plain text instead. */
  answerQuestions(sessionId: string, answers: Answers | undefined): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Lets the agent drive Relay's browser from its next turn on, or stops it. */
  setBrowserAccess(sessionId: string, on: boolean): Promise<void>;
  /** Max time a run may work before it's stopped; undefined removes the limit. */
  setRunLimit(sessionId: string, limitMs: number | undefined): Promise<void>;

  /** The user has looked at the finished output. */
  markSeen(sessionId: string): Promise<void>;
  /**
   * Marks the session and its finished forks complete, stopping any work their
   * agents left running in the background. A session in a worktree is merged
   * back first; on a conflict or error it stays open with a note.
   */
  archiveSession(sessionId: string): Promise<void>;

  /** Fires whenever anything above would return something different. */
  onDidChange(listener: () => void): Unsubscribe;

  dispose(): void;
}
