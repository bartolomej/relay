// Shared domain types. Both the extension host and the webview import from
// here, so keep this file free of Node and VS Code imports.

export type ProviderId = "claude" | "codex";

/**
 * Reasoning effort as the provider names it ("low" … "max", Codex also has "ultra").
 * Each model lists its own, so new levels work without a code change.
 */
export type Effort = string;

export type SessionStatus = "running" | "waiting" | "done" | "failed";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** From the provider's live catalogue. Empty when it isn't available. */
  models: ModelInfo[];
  /** Why the provider can't be used, e.g. the CLI isn't installed or signed in. */
  unavailable?: string;
}

export interface ModelInfo {
  id: string;
  /** Versioned name, e.g. "Opus 5.5 with 1M context". */
  label: string;
  /** Longer text and the exact model it resolves to, for a tooltip. */
  description?: string;
  /** Effort levels this model accepts; empty when it has no effort setting. */
  efforts: Effort[];
  defaultEffort?: Effort;
}

export interface SessionOptions {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

export interface PendingApproval {
  kind: "bash" | "edit" | "other";
  summary: string;
  detail: string;
  /** For file changes: a unified diff, each file under a line with its path. */
  diff?: string;
}

const MAX_DIFF_LINES = 400;

/** Caps a diff shown on an approval card, noting how much was left out. */
export function capDiff(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (lines.length <= MAX_DIFF_LINES) return lines.join("\n");
  return `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n… ${lines.length - MAX_DIFF_LINES} more lines`;
}

/** A multiple-choice question from the agent; the user picks options or types an answer. */
export interface Question {
  /** What the answer is keyed by. */
  id: string;
  /** Short tag, e.g. "Library". */
  header: string;
  question: string;
  /** Empty when only a typed answer fits. */
  options: QuestionOption[];
  multiSelect?: boolean;
  /** The typed answer is hidden while typed, e.g. a password. */
  secret?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** Per question id: the picked labels, or what the user typed. */
export type Answers = Record<string, string[]>;

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  options: SessionOptions;
  cwd: string;
  /** Short folder name shown on the card. */
  folder: string;
  createdAt: number;
  /** When the session last started working; queued follow-ups keep the same run going. */
  runStartedAt?: number;
  /** Stop the run once it has worked this long. Applies to every run until cleared. */
  runLimitMs?: number;
  /** Last time anything happened in this session (message, tool call, status). */
  lastActivityAt: number;
  /** Finished since the user last opened it. */
  unread: boolean;
  /** When the user last checked its finished output. */
  seenAt?: number;
  /** The user marked it complete. Hidden unless all past sessions are shown. */
  archived: boolean;
  /** Parent session when this one was forked. */
  parentId?: string;
  /** Message id in the parent this fork started from. */
  forkedFromMessageId?: string;
  /** 1-based index of that message in the parent, for display. */
  forkedFromIndex?: number;
  pendingApproval?: PendingApproval;
  /** The agent asked these and waits for the answers. */
  pendingQuestions?: Question[];
  /** Sent while the session was busy; delivered in order as each turn ends. */
  queued: QueuedMessage[];
  /** Context window fill as of the last model turn. */
  context?: ContextUsage;
  /** The provider's own conversation id (Claude session id, Codex thread id). */
  providerSessionId?: string;
  /** For a fork that hasn't run yet: where to branch from on its first turn. */
  forkOf?: { providerSessionId: string; atProviderMessageId?: string };
  /** Path of the transcript file on disk. */
  transcriptPath: string;
  /** Work in a git worktree of its own: created on the first message, merged back on Complete. */
  useWorktree?: boolean;
  /** The agent may drive Relay's browser; it's opened for the agent when a turn starts. */
  browserAccess?: boolean;
  worktree?: Worktree;
  /** Started by this scheduled task. */
  scheduledTaskId?: string;
}

/** How often a scheduled task runs, always at `time`. */
export type Repeat = "daily" | "weekdays" | "weekly" | "monthly";

export interface Schedule {
  repeat: Repeat;
  /** Local time of day, "HH:MM". */
  time: string;
  /** For weekly: 0 is Sunday … 6 Saturday. */
  weekday: number;
  /** For monthly: 1 to 31; a month without that day runs on its last day. */
  day: number;
}

/** What the user edits about a scheduled task. */
export interface TaskInput {
  name: string;
  /** The first and only message of each run; the agent starts fresh every time. */
  prompt: string;
  options: SessionOptions;
  schedule: Schedule;
  useWorktree: boolean;
  runLimitMs?: number;
}

/** A prompt that starts a new session on a schedule. */
export interface ScheduledTask extends TaskInput {
  id: string;
  createdAt: number;
  paused?: boolean;
  nextRunAt: number;
  lastRunAt?: number;
}

/** A session's own checkout of the project, on a branch off the one it started from. */
export interface Worktree {
  /** The worktree's root folder. */
  path: string;
  /** Where the agent works: the same subfolder of the worktree that the session's folder is of the project. */
  cwd: string;
  branch: string;
  /** The branch it started from and merges back into. */
  base: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  mode?: MessageMode;
}

/**
 * "plan" adds an instruction asking the agent to ask questions before coding.
 * "ask" adds one asking it to just answer, and runs the turn read-only.
 */
export type MessageMode = "normal" | "plan" | "ask";

/** "queue" waits for the running turn to end; "interrupt" stops it and sends now. */
export type Delivery = "queue" | "interrupt";

export interface ContextUsage {
  usedTokens: number;
  /** The model's context window. */
  limitTokens: number;
}

/**
 * One rate-limit window of a subscription plan, e.g. the rolling 5 hour
 * window or a weekly cap. Each provider reports whichever windows it has.
 */
export interface UsageWindow {
  id: string;
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  resetsAt?: number;
  /** Extra context such as "$12.40 of $50". */
  detail?: string;
}

export interface ProviderUsage {
  provider: ProviderId;
  /** Plan name when known, e.g. "Max" or "Plus". */
  plan?: string;
  windows: UsageWindow[];
  /** Values that aren't a percentage, e.g. a credit balance. */
  extras?: Array<{ label: string; value: string }>;
  /** Why no windows are shown, e.g. signed in with an API key. */
  note?: string;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant";

export interface ToolEvent {
  id: string;
  kind: "read" | "edit" | "write" | "run" | "other";
  label: string;
  target: string;
  /** File the tool touched, when it is one; makes the target open that file. */
  path?: string;
  detail?: string;
  added?: number;
  removed?: number;
  ok?: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  tools?: ToolEvent[];
  streaming?: boolean;
  /** Provider id of the last assistant message folded into this one; a fork branches here. */
  providerMessageId?: string;
  /** How a user message was sent; the text shown is what the user typed. */
  mode?: MessageMode;
}

export type ApprovalDecision = "allow" | "deny" | "always";

/** The folder the agent works in. */
export function workDir(s: Session): string {
  return s.worktree ? s.worktree.cwd : s.cwd;
}

export function isActive(s: Session): boolean {
  return s.status === "running" || s.status === "waiting";
}

/** "45m", "2h", "1h 30m" for a time limit. */
export function minutesLabel(ms: number): string {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
