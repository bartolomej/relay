import * as os from "os";
import * as path from "path";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { capDiff, type Effort, type ModelInfo, type PendingApproval, type ProviderInfo, type ProviderUsage, type Question, type ToolEvent, type UsageWindow } from "../api/types";
import type { ProviderAdapter, TurnResult, TurnSink, TurnTarget } from "./adapter";
import { findExecutable } from "./binaries";
import { BROWSER_MCP, BROWSER_PROMPT, browserMcp } from "./browserMcp";

// The SDK is ESM-only; the extension bundle is CommonJS, so it is loaded on first use.
let sdkModule: Promise<typeof Sdk> | undefined;
function loadSdk(): Promise<typeof Sdk> {
  if (!sdkModule) sdkModule = import("@anthropic-ai/claude-agent-sdk");
  return sdkModule;
}

/** Catalogue and plan usage come from one short-lived process, reused for a few seconds. */
const SNAPSHOT_TTL_MS = 10_000;

interface Snapshot {
  models: Sdk.ModelInfo[];
  usage: Sdk.SDKControlGetUsageResponse | undefined;
  at: number;
}

/** A plan row as the server renders it for /usage. Not in the SDK's types yet. */
interface LimitRow {
  kind: string;
  percent: number | null;
  resets_at: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/** All an Ask-mode turn gets: reading, searching and the web, nothing that writes. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

/**
 * Offers only the read-only tools, and a hook turns down anything else that
 * shows up anyway (MCP servers from the user's settings), before any allow rule applies.
 */
const READ_ONLY: Partial<Sdk.Options> = {
  tools: READ_ONLY_TOOLS,
  hooks: {
    PreToolUse: [
      {
        hooks: [
          async (input) =>
            input.hook_event_name === "PreToolUse" && !READ_ONLY_TOOLS.includes(input.tool_name)
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "Ask mode is read-only: read and search files, but don't change anything.",
                  },
                }
              : {},
        ],
      },
    ],
  },
};

interface ActiveTurn {
  query: Sdk.Query;
  done: Promise<void>;
}

/**
 * Claude Code through the Agent SDK, driving the user's installed `claude`
 * (so its login, settings, CLAUDE.md and model catalogue all apply). One query
 * per turn, resumed by session id.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  private active = new Map<string, ActiveTurn>();
  private snapshot: Promise<Snapshot> | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly pathOverride: () => string | undefined) {}

  // -- catalogue and usage -------------------------------------------------

  async info(): Promise<ProviderInfo> {
    const snap = await this.load();
    return { id: "claude", label: "Claude", models: snap.models.map(toModel) };
  }

  async usage(): Promise<ProviderUsage | undefined> {
    const snap = await this.load();
    return snap.usage ? toUsage(snap.usage) : undefined;
  }

  onDidChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private load(): Promise<Snapshot> {
    const cached = this.snapshot;
    if (cached) {
      return cached.then((s) => (Date.now() - s.at < SNAPSHOT_TTL_MS ? s : this.reload()));
    }
    return this.reload();
  }

  private reload(): Promise<Snapshot> {
    const next = this.control(async (q) => {
      const [models, usage] = await Promise.all([
        q.supportedModels(),
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined),
      ]);
      return { models, usage, at: Date.now() };
    });
    this.snapshot = next.catch((err: unknown) => {
      this.snapshot = undefined;
      throw err;
    });
    return this.snapshot;
  }

  /** Runs fn against a process with no prompt, so nothing is sent to the model. */
  private async control<T>(fn: (q: Sdk.Query) => Promise<T>): Promise<T> {
    const sdk = await loadSdk();
    let release = () => {};
    const idle: AsyncIterable<Sdk.SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => (release = r));
      },
    };
    const q = sdk.query({ prompt: idle, options: { pathToClaudeCodeExecutable: this.executable(), cwd: os.homedir() } });
    try {
      return await fn(q);
    } finally {
      release();
      q.close();
    }
  }

  private executable(): string {
    const found = findExecutable("claude", this.pathOverride());
    if (!found) throw new Error("Claude Code isn't installed. Install it, or set relay.claudePath.");
    return found;
  }

  // -- turns ---------------------------------------------------------------

  async runTurn(target: TurnTarget, text: string, sink: TurnSink): Promise<TurnResult> {
    const sdk = await loadSdk();
    const models = (await this.load()).models;
    const model = models.find((m) => m.value === target.options.model);
    // Only send an effort this model lists; the SDK's type is its own set of names.
    const effort = model && model.supportedEffortLevels ? model.supportedEffortLevels.find((e) => e === target.options.effort) : undefined;

    // Streaming input stays open until the result is in, so context usage can still be read.
    let closeInput = () => {};
    const inputClosed = new Promise<void>((r) => (closeInput = r));
    async function* input(): AsyncGenerator<Sdk.SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      await inputClosed;
    }

    const resume: Partial<Sdk.Options> = target.forkOf
      ? { resume: target.forkOf.providerSessionId, forkSession: true, resumeSessionAt: target.forkOf.atProviderMessageId }
      : target.providerSessionId
        ? { resume: target.providerSessionId }
        : {};
    // Turning browser access on was the user's say-so, so its tools don't ask again.
    const browser: Partial<Sdk.Options> = target.browserUrl
      ? { mcpServers: { [BROWSER_MCP]: { type: "stdio", ...browserMcp(target.browserUrl) } }, allowedTools: [`mcp__${BROWSER_MCP}`] }
      : {};
    const q = sdk.query({
      prompt: input(),
      options: {
        cwd: target.cwd,
        model: target.options.model,
        ...(effort ? { effort } : {}),
        permissionMode: "auto",
        systemPrompt: { type: "preset", preset: "claude_code", ...(target.browserUrl ? { append: BROWSER_PROMPT } : {}) },
        ...browser,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: this.executable(),
        canUseTool: (name, toolInput, opts) => this.ask(sink, target.cwd, name, toolInput, opts.suggestions),
        ...(target.readOnly ? READ_ONLY : {}),
        ...resume,
      },
    });

    let result: TurnResult = { ok: false, error: "Claude stopped without finishing the turn." };
    const run = (async () => {
      const streamed = new Set<string>();
      let wroteText = false;
      for await (const m of q) {
        switch (m.type) {
          case "system":
            if (m.subtype === "init") sink.providerSessionId(m.session_id);
            break;
          case "stream_event": {
            if (m.parent_tool_use_id) break;
            const e = m.event;
            if (e.type === "message_start") streamed.add(e.message.id);
            else if (e.type === "content_block_start" && e.content_block.type === "text" && wroteText) sink.text("\n\n");
            else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
              sink.text(e.delta.text);
              wroteText = true;
            }
            break;
          }
          case "assistant":
            if (m.parent_tool_use_id) break;
            for (const block of m.message.content) {
              if (block.type === "text" && !streamed.has(m.message.id)) {
                sink.text(wroteText ? `\n\n${block.text}` : block.text);
                wroteText = true;
              } else if (block.type === "tool_use") {
                sink.tool(toolRow(block.id, block.name, block.input as Record<string, unknown>, target.cwd));
                wroteText = false;
              }
            }
            sink.checkpoint(m.uuid);
            break;
          case "user": {
            if (m.parent_tool_use_id || typeof m.message.content === "string") break;
            for (const block of m.message.content) {
              if (block.type === "tool_result") sink.tool({ id: block.tool_use_id, ...toolResult(!!block.is_error, m.tool_use_result) } as ToolEvent);
            }
            break;
          }
          case "rate_limit_event":
            this.snapshot = undefined;
            for (const l of this.listeners) l();
            break;
          case "result":
            result = m.subtype === "success" && !m.is_error ? { ok: true } : { ok: false, error: resultError(m) };
            try {
              const ctx = await q.getContextUsage();
              sink.context({ usedTokens: ctx.totalTokens, limitTokens: ctx.maxTokens });
            } catch {
              // Context is a nice-to-have; a turn still counts without it.
            }
            closeInput();
            break;
        }
      }
    })();
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.active.set(target.sessionId, { query: q, done });
    try {
      await run;
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      closeInput();
      this.active.delete(target.sessionId);
    }
    return result;
  }

  async interrupt(sessionId: string): Promise<void> {
    const turn = this.active.get(sessionId);
    if (!turn) return;
    await turn.query.interrupt().catch(() => undefined);
    // Give Claude a moment to write the session file, so the next turn resumes cleanly.
    const settled = await Promise.race([turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!settled) turn.query.close();
  }

  dispose(): void {
    for (const t of this.active.values()) t.query.close();
    this.active.clear();
    this.listeners.clear();
  }

  private async ask(
    sink: TurnSink,
    cwd: string,
    name: string,
    input: Record<string, unknown>,
    suggestions: Sdk.PermissionUpdate[] | undefined,
  ): Promise<Sdk.PermissionResult> {
    if (name === "AskUserQuestion") {
      const answers = await sink.questions(toQuestions(input));
      if (!answers) return { behavior: "deny", message: "The user would rather answer in a message. Ask your questions in plain text instead." };
      // Keyed by question text; several picks are comma-separated.
      const byQuestion: Record<string, string> = {};
      for (const [question, picked] of Object.entries(answers)) byQuestion[question] = picked.join(", ");
      return { behavior: "allow", updatedInput: { ...input, answers: byQuestion } };
    }
    const decision = await sink.approval(approvalFor(name, input, cwd));
    if (decision === "deny") return { behavior: "deny", message: "The user declined this." };
    return { behavior: "allow", updatedInput: input, ...(decision === "always" && suggestions ? { updatedPermissions: suggestions } : {}) };
  }
}

// -- mapping ----------------------------------------------------------------

/** AskUserQuestion's input; answers go back keyed by the question text. */
function toQuestions(input: Record<string, unknown>): Question[] {
  const questions = (input as Partial<AskUserQuestionInput>).questions || [];
  return questions.map((q) => ({
    id: q.question,
    header: q.header,
    question: q.question,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
    multiSelect: q.multiSelect,
  }));
}

function toModel(m: Sdk.ModelInfo): ModelInfo {
  const efforts: Effort[] = m.supportedEffortLevels ? m.supportedEffortLevels.slice() : [];
  const name = versionedName(m);
  return {
    id: m.value,
    label: name,
    description: [m.description, m.resolvedModel].filter(Boolean).join("\n"),
    efforts,
    defaultEffort: efforts.includes("high") ? "high" : efforts[efforts.length - 1],
  };
}

/**
 * The catalogue's displayName is often just "Opus". Its description starts
 * with the versioned name ("Opus 5.5 with 1M context · Best for …"), so use
 * that without the context size ("Opus 5.5"), else build one from the resolved
 * id ("claude-haiku-4-5-20251001" → "Haiku 4.5"). The tooltip keeps the full text.
 */
function versionedName(m: Sdk.ModelInfo): string {
  const head = m.description ? m.description.split(" · ")[0].replace(/ with \S+ context$/i, "").trim() : "";
  if (head && /\d/.test(head)) return head;
  const id = m.resolvedModel || m.value;
  const match = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(?:\[1m\])?$/.exec(id);
  if (!match) return m.displayName;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `${family} ${match[2].replace(/-/g, ".")}`;
}

function toUsage(u: Sdk.SDKControlGetUsageResponse): ProviderUsage {
  const now = Date.now();
  const plan = u.subscription_type ? u.subscription_type.charAt(0).toUpperCase() + u.subscription_type.slice(1) : undefined;
  if (!u.rate_limits_available || !u.rate_limits) {
    return { provider: "claude", plan, windows: [], note: "Plan limits need a Claude subscription login, not an API key.", updatedAt: now };
  }
  const limits = u.rate_limits as typeof u.rate_limits & { limits?: LimitRow[] };
  const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : undefined);
  let windows: UsageWindow[];
  if (limits.limits && limits.limits.length) {
    // The server's own rows, as /usage shows them.
    windows = limits.limits.map((row, i) => ({
      id: `${row.kind}-${i}`,
      label:
        row.kind === "session"
          ? "Session (5h)"
          : row.kind === "weekly_all"
            ? "Week · all models"
            : `Week · ${(row.scope && row.scope.model && row.scope.model.display_name) || row.kind}`,
      usedPercent: row.percent || 0,
      resetsAt: time(row.resets_at),
    }));
  } else {
    windows = [];
    const add = (id: string, label: string, w: { utilization: number | null; resets_at: string | null } | null | undefined) => {
      if (w && w.utilization !== null) windows.push({ id, label, usedPercent: w.utilization, resetsAt: time(w.resets_at) });
    };
    add("five_hour", "Session (5h)", limits.five_hour);
    add("seven_day", "Week · all models", limits.seven_day);
    add("seven_day_opus", "Week · Opus", limits.seven_day_opus);
    add("seven_day_sonnet", "Week · Sonnet", limits.seven_day_sonnet);
    for (const m of limits.model_scoped || []) add(`model_scoped:${m.display_name}`, `Week · ${m.display_name}`, m);
  }
  const extra = limits.extra_usage;
  if (extra && extra.is_enabled && extra.utilization !== null) {
    const scale = Math.pow(10, (extra as { decimal_places?: number | null }).decimal_places || 0);
    const money = (n: number | null) => (n === null ? "?" : (n / scale).toFixed(2));
    const currency = (extra as { currency?: string | null }).currency || "";
    windows.push({
      id: "extra_usage",
      label: "Extra usage",
      usedPercent: extra.utilization,
      detail: `${money(extra.used_credits)} of ${money(extra.monthly_limit)} ${currency} this month`.trim(),
    });
  }
  return { provider: "claude", plan, windows, updatedAt: now };
}

function rel(cwd: string, file: unknown): string {
  if (typeof file !== "string") return "";
  const r = path.relative(cwd, file);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : file;
}

function str(v: unknown, max = 200): string {
  const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  const line = s.split("\n")[0];
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function toolRow(id: string, name: string, input: Record<string, unknown>, cwd: string): ToolEvent {
  switch (name) {
    case "Read":
      return { id, kind: "read", label: "Read", target: rel(cwd, input.file_path), path: str(input.file_path, 4096) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { id, kind: "edit", label: "Edited", target: rel(cwd, input.file_path || input.notebook_path), path: str(input.file_path || input.notebook_path, 4096) };
    case "Write":
      return { id, kind: "write", label: "Wrote", target: rel(cwd, input.file_path), path: str(input.file_path, 4096) };
    case "Bash":
      return { id, kind: "run", label: "Ran", target: str(input.command) };
    case "Grep":
      return { id, kind: "read", label: "Searched", target: str(input.pattern) };
    case "Glob":
      return { id, kind: "read", label: "Listed", target: str(input.pattern) };
    case "WebFetch":
      return { id, kind: "other", label: "Fetched", target: str(input.url) };
    case "WebSearch":
      return { id, kind: "other", label: "Searched web", target: str(input.query) };
    case "AskUserQuestion":
      return { id, kind: "other", label: "Asked", target: toQuestions(input).map((q) => q.question).join(" · ") };
    case "Task":
    case "Agent":
      return { id, kind: "other", label: "Delegated", target: str(input.description) };
    default:
      return { id, kind: "other", label: name, target: str(input) };
  }
}

/** Fills in how a tool call went, with line counts for file edits. */
function toolResult(isError: boolean, result: unknown): Partial<ToolEvent> {
  const out: Partial<ToolEvent> = { ok: !isError };
  if (isError) out.detail = "failed";
  const r = result as { structuredPatch?: Array<{ lines?: string[] }>; type?: string; content?: string; answers?: Record<string, string> } | undefined;
  if (r && r.answers && typeof r.answers === "object") {
    // An answered AskUserQuestion: show what was picked next to each question.
    out.target = Object.entries(r.answers)
      .map(([q, a]) => `${q} ${a}`)
      .join(" · ");
  } else if (r && Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of r.structuredPatch) {
      for (const line of hunk.lines || []) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    }
    out.added = added;
    out.removed = removed;
  } else if (r && r.type === "create" && typeof r.content === "string") {
    out.added = r.content.split("\n").length;
    out.removed = 0;
  }
  return out;
}

function approvalFor(name: string, input: Record<string, unknown>, cwd: string): PendingApproval {
  switch (name) {
    case "Bash":
      return { kind: "bash", summary: "wants to run a command", detail: String(input.command || "") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const file = rel(cwd, input.file_path || input.notebook_path);
      const diff = editDiff(name, input);
      return { kind: "edit", summary: `wants to ${name === "Write" ? "write" : "edit"} a file`, detail: file, diff: diff ? capDiff(`${file}\n${diff}`) : undefined };
    }
    default:
      return { kind: "other", summary: `wants to use ${name}`, detail: str(input, 400) };
  }
}

/** The replaced text as "-" lines and its replacement as "+" lines; a written file is all "+". */
function editDiff(name: string, input: Record<string, unknown>): string {
  const lines = (text: unknown, mark: string) =>
    typeof text === "string" && text
      ? text
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => mark + l)
      : [];
  if (name === "Write") return lines(input.content, "+").join("\n");
  const edits = name === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
  return edits
    .map((e) => ["@@", ...lines(e.old_string, "-"), ...lines(e.new_string, "+")].join("\n"))
    .filter((hunk) => hunk !== "@@")
    .join("\n");
}

function resultError(m: Sdk.SDKResultMessage): string {
  if (m.subtype === "success") return (m as { result?: string }).result || "Claude reported an error.";
  return m.errors && m.errors.length ? m.errors.join("\n") : `Claude stopped: ${m.subtype.replace(/_/g, " ")}.`;
}
