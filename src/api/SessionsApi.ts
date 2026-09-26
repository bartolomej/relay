import type { ApprovalDecision, Delivery, Message, ProviderInfo, ProviderUsage, Session, SessionOptions } from "./types";

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

  /** With `useWorktree`, the agent works in a git worktree created on the first message. */
  createSession(options: SessionOptions, cwd: string, useWorktree?: boolean): Promise<Session>;
  /**
   * Sends right away when the session is idle. While it's working, "queue"
   * holds the message until the turn ends and "interrupt" stops the turn first.
   * Also brings an archived session (and its ancestors) back.
   */
  sendMessage(sessionId: string, text: string, options?: Partial<SessionOptions>, delivery?: Delivery): Promise<void>;
  removeQueued(sessionId: string, queuedId: string): Promise<void>;
  forkSession(sessionId: string, fromMessageId?: string): Promise<Session>;
  stopSession(sessionId: string): Promise<void>;
  respondToApproval(sessionId: string, decision: ApprovalDecision): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Max time a run may work before it's stopped; undefined removes the limit. */
  setRunLimit(sessionId: string, limitMs: number | undefined): Promise<void>;

  /** The user has looked at the finished output. */
  markSeen(sessionId: string): Promise<void>;
  /**
   * Marks the session and its finished forks complete. A session in a worktree
   * is merged back first; on a conflict or error it stays open with a note.
   */
  archiveSession(sessionId: string): Promise<void>;

  /** Fires whenever anything above would return something different. */
  onDidChange(listener: () => void): Unsubscribe;

  dispose(): void;
}
