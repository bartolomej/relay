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
  /** Versioned name, e.g. "Opus 5.5 1M". */
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

/** How hard a message looks to Jev, which picks the model suggested for it. */
export type Difficulty = "simple" | "standard" | "complex";

/** A model for the message being typed, in the composer's provider. */
export interface ModelSuggestion {
  difficulty: Difficulty;
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
  /** Tokens this session has spent so far, over all its turns. */
  tokens?: TokenTotals;
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
  /** Work the agent left running between turns; it picks up again as each one finishes. */
  background?: BackgroundTask[];
}

/** A command or subagent the agent runs in the background, e.g. a long build or eval. */
export interface BackgroundTask {
  id: string;
  /** What the agent said it's for, e.g. "Run the eval". */
  description: string;
  /** The shell command, for a command; a subagent has none. */
  command?: string;
  startedAt: number;
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

export interface TokenTotals {
  /** Everything the model read, summed over every request; cache hits included. */
  input: number;
  /** The part of `input` served from the prompt cache. */
  cachedInput: number;
  output: number;
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

/** What the inspector shows about a Claude session: how it was set up and how it ran. */
export interface SessionInspect {
  /** How Claude Code started the latest turn. */
  setup?: InspectSetup;
  /** What filled the context window after the latest turn. */
  context?: InspectContext;
  stats?: InspectStats;
  /** Every tool call, subagents' included, oldest first. */
  tools: InspectTool[];
  events: InspectEvent[];
}

export interface InspectSetup {
  model: string;
  version: string;
  permissionMode: string;
  outputStyle: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  skills: string[];
  agents: string[];
  plugins: string[];
}

export interface InspectContext {
  usedTokens: number;
  limitTokens: number;
  /** Compaction starts once the context reaches this many tokens. */
  autoCompactAt?: number;
  /** What fills the window: system prompt, tools, memory files, messages, free space and so on. */
  categories: Array<{ name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }>;
  /** CLAUDE.md and other memory files, by path. */
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  skills: Array<{ name: string; source: string; tokens: number }>;
  agents: Array<{ name: string; source: string; tokens: number }>;
  /** `loaded` is false while the tool is deferred: the model sees its name and loads the schema when it needs it. */
  mcpTools: Array<{ name: string; server: string; tokens: number; loaded?: boolean }>;
  /** Tokens tool calls and their results take up in the conversation, per tool. */
  toolTokens: Array<{ name: string; tokens: number }>;
}

/** Summed over the session's turns, except cost and models: Claude Code keeps those as running totals. */
export interface InspectStats {
  turns: number;
  /** Requests to the model; one turn makes a request per round of tool calls. */
  roundTrips: number;
  durationMs: number;
  apiDurationMs: number;
  costUsd: number;
  models: Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }>;
}

export interface InspectTool {
  id: string;
  /** The tool's own name, e.g. Read or mcp__relay_browser__click. */
  name: string;
  kind: ToolEvent["kind"];
  label: string;
  target: string;
  path?: string;
  /** The subagent that made the call; unset for the main agent. */
  agent?: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  /** Rough size of what the tool returned, at 4 characters a token. */
  resultTokens?: number;
}

export interface InspectEvent {
  at: number;
  kind: "turn" | "compact" | "retry" | "hook" | "denied" | "approval" | "memory" | "subagent" | "limit" | "error";
  text: string;
  detail?: string;
}

/** One change to a session's inspector data, as an adapter reports it. */
export interface InspectUpdate {
  setup?: InspectSetup;
  context?: InspectContext;
  /** A finished turn; its numbers are added to the stats. */
  turn?: { roundTrips: number; durationMs: number; apiDurationMs: number; costUsd: number; models: InspectStats["models"] };
  /** Adds a tool call, or fills in the one with the same id. */
  tool?: Partial<InspectTool> & { id: string };
  event?: InspectEvent;
}

/** The folder the agent works in. */
export function workDir(s: Session): string {
  return s.worktree ? s.worktree.cwd : s.cwd;
}

export function isActive(s: Session): boolean {
  return s.status === "running" || s.status === "waiting";
}

export function hasBackground(s: Session): boolean {
  return !!s.background && s.background.length > 0;
}

/** "0.4s", "45s", "2m 14s", "1h 3m" for how long something took. */
export function durationLabel(ms: number): string {
  if (ms < 10_000) return `${Math.round(ms / 100) / 10}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "45m", "2h", "1h 30m" for a time limit. */
export function minutesLabel(ms: number): string {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
