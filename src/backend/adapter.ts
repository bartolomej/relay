import type {
  Answers,
  ApprovalDecision,
  ContextUsage,
  PendingApproval,
  ProviderId,
  ProviderInfo,
  ProviderUsage,
  Question,
  SessionOptions,
  ToolEvent,
} from "../api/types";

/** What an adapter needs to know about the session it runs a turn for. */
export interface TurnTarget {
  sessionId: string;
  cwd: string;
  options: SessionOptions;
  /** The provider's own id for this conversation, once it has one. */
  providerSessionId?: string;
  /** Set on a fork's first turn: branch off this conversation, optionally at a message. */
  forkOf?: { providerSessionId: string; atProviderMessageId?: string };
  /** Ask mode: the agent may read and search, but not change anything. */
  readOnly?: boolean;
  /** Relay's browser, for the agent to drive through Chrome DevTools MCP. */
  browserUrl?: string;
}

/** Callbacks an adapter drives while a turn runs. */
export interface TurnSink {
  /** The provider's id for this conversation (new, resumed or forked). */
  providerSessionId(id: string): void;
  /** Streamed assistant text. */
  text(delta: string): void;
  /** Adds a tool row, or updates the one with the same id. */
  tool(event: ToolEvent): void;
  /** Resolves with the user's answer. */
  approval(request: PendingApproval): Promise<ApprovalDecision>;
  /** Resolves with the user's answers, or undefined when they'd rather answer in a message. */
  questions(questions: Question[]): Promise<Answers | undefined>;
  context(usage: ContextUsage): void;
  /** Provider id of the latest assistant message, so a fork can branch at it. */
  checkpoint(providerMessageId: string): void;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
}

/** One provider behind a common shape. The session rules live in RealSessionsApi. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Live model catalogue; never hardcoded, so new models show up on their own. */
  info(): Promise<ProviderInfo>;
  usage(): Promise<ProviderUsage | undefined>;
  runTurn(target: TurnTarget, text: string, sink: TurnSink): Promise<TurnResult>;
  interrupt(sessionId: string): Promise<void>;
  /** Called when plan usage changed (e.g. a rate-limit event arrived). */
  onDidChange(listener: () => void): void;
  dispose(): void;
}
