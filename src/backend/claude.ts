import * as os from "os";
import * as path from "path";
import type * as Sdk from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { capDiff, durationLabel, type BackgroundTask, type Effort, type InspectContext, type InspectEvent, type InspectSetup, type InspectUpdate, type ModelInfo, type PendingApproval, type ProviderInfo, type ProviderUsage, type Question, type TokenTotals, type ToolEvent, type UsageWindow } from "../api/types";
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

/** One turn in a Claude process: where its events go, and how it ends. */
interface Turn {
  sink: TurnSink;
  /** Settles with the turn's result. */
  done: Promise<TurnResult>;
  finish: (result: TurnResult) => void;
  wroteText: boolean;
  /** Started by the agent rather than by a message of the user's. */
  agent: boolean;
}

function newTurn(sink: TurnSink, agent = false): Turn {
  let finish: (result: TurnResult) => void = () => {};
  const done = new Promise<TurnResult>((r) => (finish = r));
  return { sink, done, finish, wroteText: false, agent };
}

/** Where an agent turn's events go until Relay takes it on. */
const NO_SINK: TurnSink = {
  providerSessionId: () => {},
  text: () => {},
  tool: () => {},
  approval: async () => "deny",
  questions: async () => undefined,
  context: () => {},
  tokens: () => {},
  checkpoint: () => {},
  inspect: () => {},
};

/**
 * A session's Claude process. Its input closes once the agent is idle with
 * nothing left in the background, which ends it; until then the agent hears
 * as background work finishes, and new messages go into the same process.
 */
interface Proc {
  query: Sdk.Query;
  /** What it was started with besides the model; a turn that needs other settings gets a new process. */
  settings: string;
  model: string;
  send: (text: string) => void;
  /** Closes input; the process exits once it has settled. */
  end: () => void;
  /** Input is closed, so a message sent now would never reach Claude. */
  ending: boolean;
  turn: Turn | undefined;
  background: BackgroundTask[];
  /** Inspector updates that came between turns, for the next one. */
  pending: InspectUpdate[];
  /** Settles once the process has exited. */
  done: Promise<void>;
}

/**
 * Claude Code through the Agent SDK, driving the user's installed `claude`
 * (so its login, settings, CLAUDE.md and model catalogue all apply). A process
 * per turn, resumed by session id, unless background work keeps it around.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  private procs = new Map<string, Proc>();
  private snapshot: Promise<Snapshot> | undefined;
  private listeners = new Set<() => void>();
  private backgroundListeners = new Set<(sessionId: string, tasks: BackgroundTask[]) => void>();
  private agentTurnListeners = new Set<(sessionId: string, run: (sink: TurnSink) => Promise<TurnResult>) => void>();

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
    const proc = await this.procFor(target, sink);
    const turn = newTurn(sink);
    this.attach(proc, turn);
    sink.inspect({ event: { at: Date.now(), kind: "turn", text: `Sent: ${str(text, 160)}` } });
    proc.send(text);
    return turn.done;
  }

  onBackground(listener: (sessionId: string, tasks: BackgroundTask[]) => void): void {
    this.backgroundListeners.add(listener);
  }

  onAgentTurn(listener: (sessionId: string, run: (sink: TurnSink) => Promise<TurnResult>) => void): void {
    this.agentTurnListeners.add(listener);
  }

  async stopBackground(sessionId: string): Promise<void> {
    const proc = this.procs.get(sessionId);
    if (!proc) return;
    await Promise.all(proc.background.map((t) => proc.query.stopTask(t.id).catch(() => undefined)));
    // A turn in flight ends the process by itself once it's idle.
    if (proc.turn) return;
    proc.query.close();
    await proc.done;
  }

  /** The session's process if it's still around and suits this turn, else a new one. */
  private async procFor(target: TurnTarget, sink: TurnSink): Promise<Proc> {
    const models = (await this.load()).models;
    const model = models.find((m) => m.value === target.options.model);
    // Only send an effort this model lists; the SDK's type is its own set of names.
    const effort = model && model.supportedEffortLevels ? model.supportedEffortLevels.find((e) => e === target.options.effort) : undefined;
    const settings = JSON.stringify([target.cwd, effort, !!target.readOnly, target.browserUrl]);
    let proc = this.procs.get(target.sessionId);
    // A turn the agent started by itself goes first.
    // So does one that's on its way out: its input is closed.
    while (proc && (proc.turn || proc.ending)) {
      await (proc.turn ? proc.turn.done : proc.done);
      proc = this.procs.get(target.sessionId);
    }
    if (proc && proc.settings !== settings) {
      sink.inspect({ event: { at: Date.now(), kind: "turn", text: "Stopped the background work: this message needs Claude restarted with other settings" } });
      await this.stopBackground(target.sessionId);
      proc = undefined;
    }
    if (proc) {
      if (proc.model !== target.options.model) {
        await proc.query.setModel(target.options.model);
        proc.model = target.options.model;
      }
      return proc;
    }
    return this.start(target, settings, effort);
  }

  private async start(target: TurnTarget, settings: string, effort: Sdk.EffortLevel | undefined): Promise<Proc> {
    const sdk = await loadSdk();
    const queue: string[] = [];
    let ended = false;
    let wake = () => {};
    async function* input(): AsyncGenerator<Sdk.SDKUserMessage> {
      for (;;) {
        for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
          yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
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
    const turnSink = () => (proc.turn ? proc.turn.sink : NO_SINK);
    const query = sdk.query({
      prompt: input(),
      options: {
        cwd: target.cwd,
        model: target.options.model,
        ...(effort ? { effort } : {}),
        permissionMode: "auto",
        systemPrompt: { type: "preset", preset: "claude_code", ...(target.browserUrl ? { append: BROWSER_PROMPT } : {}) },
        ...browser,
        includePartialMessages: true,
        includeHookEvents: true,
        // "idle" says when the agent is done for now, background work and all.
        env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
        // Stop only ends the turn; background work is stopped on its own, or on Complete.
        perTaskStopAffordance: true,
        pathToClaudeCodeExecutable: this.executable(),
        canUseTool: (name, toolInput, opts) => this.ask(turnSink(), target.cwd, name, toolInput, opts.suggestions),
        ...(target.readOnly ? READ_ONLY : {}),
        ...resume,
      },
    });
    const proc: Proc = {
      query,
      settings,
      model: target.options.model,
      send: (text) => {
        queue.push(text);
        wake();
      },
      end: () => {
        ended = true;
        proc.ending = true;
        wake();
      },
      ending: false,
      turn: undefined,
      background: [],
      pending: [],
      done: Promise.resolve(),
    };
    let failure: string | undefined;
    proc.done = this.read(target.sessionId, proc, target.cwd)
      .catch((err: unknown) => {
        failure = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        // Ended by us once Claude went idle, so a turn the agent opened since had nothing more coming.
        const settled = !failure && proc.ending && !!proc.turn && proc.turn.agent;
        ended = true;
        wake();
        if (this.procs.get(target.sessionId) === proc) this.procs.delete(target.sessionId);
        if (proc.turn) proc.turn.finish(settled ? { ok: true } : { ok: false, error: failure || "Claude stopped without finishing the turn." });
        proc.turn = undefined;
        if (proc.background.length) this.setBackground(target.sessionId, proc, []);
      });
    this.procs.set(target.sessionId, proc);
    return proc;
  }

  /** Streams the process's messages into whichever turn is current, until it exits. */
  private async read(sessionId: string, proc: Proc, cwd: string): Promise<void> {
    const q = proc.query;
    const streamed = new Set<string>();
    // Per stream (the main loop, each subagent): usage of the message in flight so far.
    const counted = new Map<string, RawUsage>();
    // Subagents by the id of the Task call that started them, for the inspector.
    const agents = new Map<string, string>();
    // Background tasks by id, for the inspector.
    const tasks = new Map<string, string>();
    // Shell commands by the id of the Bash call that ran them, then by the task they turned into.
    const commands = new Map<string, string>();
    const taskCommands = new Map<string, string>();
    // Older CLIs don't say when they're idle; for them, a result is the end.
    let sawState = false;
    const inspect = (u: InspectUpdate) => (proc.turn ? proc.turn.sink.inspect(u) : proc.pending.push(u));
    const event = (kind: InspectEvent["kind"], text: string, detail?: string) => inspect({ event: { at: Date.now(), kind, text, detail } });
    // Anything a turn says starts one when none is current: the agent carries on by itself.
    let last = "";
    const turn = (): Turn => {
      if (proc.turn) return proc.turn;
      const t = this.agentTurn(sessionId, proc);
      event("turn", `Claude carried on by itself, starting with ${last}`);
      return t;
    };
    for await (const m of q) {
      last = [m.type, "subtype" in m ? m.subtype : undefined, m.type === "stream_event" ? m.event.type : undefined, "state" in m ? m.state : undefined]
        .filter(Boolean)
        .join(" ");
      switch (m.type) {
        case "system":
          if (m.subtype === "init") {
            const t = turn();
            t.sink.providerSessionId(m.session_id);
            t.sink.inspect({ setup: toSetup(m) });
          } else if (m.subtype === "session_state_changed") {
            sawState = true;
            if (m.state === "running") turn();
            else if (m.state === "idle" && !proc.background.length) proc.end();
          } else if (m.subtype === "background_tasks_changed") {
            const before = new Map(proc.background.map((t) => [t.id, t]));
            const next = m.tasks
              .filter((t) => !t.ambient)
              .map((t): BackgroundTask => before.get(t.task_id) || { id: t.task_id, description: t.description, command: taskCommands.get(t.task_id), startedAt: Date.now() });
            this.setBackground(sessionId, proc, next);
          } else if (m.subtype === "task_started") {
            tasks.set(m.task_id, m.description);
            // Usually comes just after the task joined the background list, which only says what it's for.
            const command = m.tool_use_id ? commands.get(m.tool_use_id) : undefined;
            if (command) taskCommands.set(m.task_id, command);
            if (command && proc.background.some((t) => t.id === m.task_id)) {
              this.setBackground(sessionId, proc, proc.background.map((t) => (t.id === m.task_id ? { ...t, command } : t)));
            }
          } else if (m.subtype === "compact_boundary") {
            const c = m.compact_metadata;
            const after = c.post_tokens !== undefined ? ` to ${c.post_tokens.toLocaleString()}` : "";
            event("compact", `Compacted (${c.trigger}) from ${c.pre_tokens.toLocaleString()}${after} tokens`);
          } else if (m.subtype === "api_retry") {
            const why = m.error_status !== null ? `HTTP ${m.error_status}` : "no response";
            event("retry", `API retry ${m.attempt} of ${m.max_retries} after ${why}, waiting ${durationLabel(m.retry_delay_ms)}`);
          } else if (m.subtype === "hook_response") {
            // Hooks run on every prompt and tool call; only the ones with something to say are worth a row.
            const out = [m.stderr, m.stdout, m.output].find((x) => x && x.trim());
            if (out || m.outcome !== "success") event("hook", `Hook ${m.hook_name}: ${m.outcome}`, out ? str(out, 400) : undefined);
          } else if (m.subtype === "permission_denied") {
            event("denied", `Denied ${m.tool_name} without asking`, m.decision_reason || m.message);
          } else if (m.subtype === "memory_recall") {
            event("memory", `Recalled ${m.memories.length} ${m.memories.length === 1 ? "memory" : "memories"}`, m.memories.map((x) => x.path).join("\n"));
          } else if (m.subtype === "task_notification") {
            const name = (m.tool_use_id && agents.get(m.tool_use_id)) || tasks.get(m.task_id) || "Subagent";
            const u = m.usage;
            const stats = u ? `: ${u.tool_uses} tool calls, ${u.total_tokens.toLocaleString()} tokens, ${durationLabel(u.duration_ms)}` : "";
            event("subagent", `${name} ${m.status}${stats}`, m.summary ? str(m.summary, 400) : undefined);
          }
          break;
        case "stream_event": {
          const t = turn();
          const e = m.event;
          // Subagents spend tokens too, so they count before their text is skipped.
          if (e.type === "message_start" || e.type === "message_delta") {
            const key = m.parent_tool_use_id || "";
            const before = e.type === "message_start" ? undefined : counted.get(key);
            const now = mergeUsage(e.type === "message_start" ? e.message.usage : e.usage, before);
            counted.set(key, now);
            const [a, b] = [totals(now), totals(before)];
            t.sink.tokens({ input: a.input - b.input, cachedInput: a.cachedInput - b.cachedInput, output: a.output - b.output });
          }
          if (m.parent_tool_use_id) break;
          if (e.type === "message_start") streamed.add(e.message.id);
          else if (e.type === "content_block_start" && e.content_block.type === "text" && t.wroteText) t.sink.text("\n\n");
          else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
            t.sink.text(e.delta.text);
            t.wroteText = true;
          }
          break;
        }
        case "assistant": {
          const t = turn();
          // Every call goes to the inspector, a subagent's too; only the main agent's show in the chat.
          const agent = m.parent_tool_use_id ? agents.get(m.parent_tool_use_id) || "Subagent" : undefined;
          for (const block of m.message.content) {
            if (block.type !== "tool_use") continue;
            const toolInput = block.input as Record<string, unknown>;
            t.sink.inspect({ tool: { ...toolRow(block.id, block.name, toolInput, cwd), name: block.name, agent, startedAt: Date.now() } });
            if (block.name === "Task" || block.name === "Agent") agents.set(block.id, str(toolInput.description || toolInput.subagent_type) || "Subagent");
            if (block.name === "Bash" && typeof toolInput.command === "string") commands.set(block.id, toolInput.command);
          }
          if (m.parent_tool_use_id) break;
          for (const block of m.message.content) {
            if (block.type === "text" && !streamed.has(m.message.id)) {
              t.sink.text(t.wroteText ? `\n\n${block.text}` : block.text);
              t.wroteText = true;
            } else if (block.type === "tool_use") {
              t.sink.tool(toolRow(block.id, block.name, block.input as Record<string, unknown>, cwd));
              t.wroteText = false;
            }
          }
          t.sink.checkpoint(m.uuid);
          break;
        }
        case "user": {
          if (typeof m.message.content === "string") break;
          const t = turn();
          for (const block of m.message.content) {
            if (block.type !== "tool_result") continue;
            t.sink.inspect({ tool: { id: block.tool_use_id, endedAt: Date.now(), ok: !block.is_error, resultTokens: approxTokens(block.content) } });
            if (!m.parent_tool_use_id) t.sink.tool({ id: block.tool_use_id, ...toolResult(!!block.is_error, m.tool_use_result) } as ToolEvent);
          }
          break;
        }
        case "rate_limit_event": {
          this.snapshot = undefined;
          for (const l of this.listeners) l();
          const r = m.rate_limit_info;
          if (r.status !== "allowed") {
            // A fraction, 0.8 for 80%.
            const pct = r.utilization !== undefined ? ` at ${Math.round(r.utilization * 100)}%` : "";
            event("limit", `${r.status === "rejected" ? "Hit" : "Close to"} the ${(r.rateLimitType || "plan").replace(/_/g, " ")} limit${pct}`);
          }
          break;
        }
        case "result": {
          const t = turn();
          const result: TurnResult = m.subtype === "success" && !m.is_error ? { ok: true } : { ok: false, error: resultError(m) };
          t.sink.inspect({
            turn: {
              roundTrips: m.num_turns,
              durationMs: m.duration_ms,
              apiDurationMs: m.duration_api_ms,
              costUsd: m.total_cost_usd,
              models: Object.entries(m.modelUsage).map(([model, u]) => ({
                model,
                input: u.inputTokens,
                output: u.outputTokens,
                cacheRead: u.cacheReadInputTokens,
                cacheWrite: u.cacheCreationInputTokens,
                costUsd: u.costUSD,
              })),
            },
          });
          if (result.ok) event("turn", `Turn done: ${m.num_turns} ${m.num_turns === 1 ? "request" : "requests"} in ${durationLabel(m.duration_ms)}`);
          else event("error", "Turn failed", result.error);
          try {
            const ctx = await q.getContextUsage();
            t.sink.context({ usedTokens: ctx.totalTokens, limitTokens: ctx.maxTokens });
            t.sink.inspect({ context: toContext(ctx) });
          } catch {
            // Context is a nice-to-have; a turn still counts without it.
          }
          if (proc.turn === t) proc.turn = undefined;
          t.finish(result);
          if (!sawState && !proc.background.length) proc.end();
          break;
        }
      }
    }
  }

  /** Makes `turn` the process's current one, handing it what came in between turns. */
  private attach(proc: Proc, turn: Turn): void {
    proc.turn = turn;
    for (const u of proc.pending.splice(0)) turn.sink.inspect(u);
  }

  /** A turn the agent started by itself, e.g. as background work finished. */
  private agentTurn(sessionId: string, proc: Proc): Turn {
    const turn = newTurn(NO_SINK, true);
    proc.turn = turn;
    for (const l of this.agentTurnListeners) {
      l(sessionId, (sink) => {
        turn.sink = sink;
        this.attach(proc, turn);
        return turn.done;
      });
    }
    return turn;
  }

  private setBackground(sessionId: string, proc: Proc, tasks: BackgroundTask[]): void {
    proc.background = tasks;
    for (const l of this.backgroundListeners) l(sessionId, tasks.slice());
  }

  async interrupt(sessionId: string): Promise<void> {
    const proc = this.procs.get(sessionId);
    const turn = proc && proc.turn;
    if (!proc || !turn) return;
    await proc.query.interrupt().catch(() => undefined);
    // Give Claude a moment to write the session file, so the next turn resumes cleanly.
    const settled = await Promise.race([turn.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!settled) proc.query.close();
  }

  dispose(): void {
    for (const p of this.procs.values()) p.query.close();
    this.procs.clear();
    this.listeners.clear();
    this.backgroundListeners.clear();
    this.agentTurnListeners.clear();
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
      const count = Object.keys(answers || {}).length;
      sink.inspect({ event: { at: Date.now(), kind: "approval", text: answers ? `You answered ${count} ${count === 1 ? "question" : "questions"}` : "You chose to answer in a message" } });
      if (!answers) return { behavior: "deny", message: "The user would rather answer in a message. Ask your questions in plain text instead." };
      // Keyed by question text; several picks are comma-separated.
      const byQuestion: Record<string, string> = {};
      for (const [question, picked] of Object.entries(answers)) byQuestion[question] = picked.join(", ");
      return { behavior: "allow", updatedInput: { ...input, answers: byQuestion } };
    }
    const request = approvalFor(name, input, cwd);
    const decision = await sink.approval(request);
    const verb = decision === "deny" ? "You denied" : decision === "always" ? "You always allowed" : "You allowed";
    sink.inspect({ event: { at: Date.now(), kind: "approval", text: `${verb} ${name}`, detail: str(request.detail, 400) } });
    if (decision === "deny") return { behavior: "deny", message: "The user declined this." };
    return { behavior: "allow", updatedInput: input, ...(decision === "always" && suggestions ? { updatedPermissions: suggestions } : {}) };
  }
}

// -- mapping ----------------------------------------------------------------

/** A message's usage as the API counts it: cumulative within the message. */
interface RawUsage {
  input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number | null;
}

/** Fills in what a delta left out (null) with the message's earlier values. */
function mergeUsage(u: RawUsage, before: RawUsage | undefined): RawUsage {
  const or = (v: number | null, k: keyof RawUsage) => (v !== null ? v : before ? before[k] : 0);
  return {
    input_tokens: or(u.input_tokens, "input_tokens"),
    cache_creation_input_tokens: or(u.cache_creation_input_tokens, "cache_creation_input_tokens"),
    cache_read_input_tokens: or(u.cache_read_input_tokens, "cache_read_input_tokens"),
    output_tokens: or(u.output_tokens, "output_tokens"),
  };
}

/** Everything read counts as input, cache hits and writes included. */
function totals(u: RawUsage | undefined): TokenTotals {
  if (!u) return { input: 0, cachedInput: 0, output: 0 };
  const cached = u.cache_read_input_tokens || 0;
  return { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached, cachedInput: cached, output: u.output_tokens || 0 };
}

function toSetup(m: Sdk.SDKSystemMessage): InspectSetup {
  return {
    model: m.model,
    version: m.claude_code_version,
    permissionMode: m.permissionMode,
    outputStyle: m.output_style,
    tools: m.tools,
    mcpServers: m.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
    skills: m.skills,
    agents: m.agents || [],
    plugins: m.plugins.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)),
  };
}

function toContext(c: Sdk.SDKControlGetContextUsageResponse): InspectContext {
  return {
    usedTokens: c.totalTokens,
    limitTokens: c.maxTokens,
    autoCompactAt: c.isAutoCompactEnabled ? c.autoCompactThreshold : undefined,
    categories: c.categories.filter((x) => x.tokens > 0).map((x) => ({ name: x.name, tokens: x.tokens, kind: x.kind })),
    memoryFiles: c.memoryFiles.map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
    skills: c.skills ? c.skills.skillFrontmatter.map((s) => ({ name: s.name, source: s.source, tokens: s.tokens })) : [],
    agents: c.agents.map((a) => ({ name: a.agentType, source: a.source, tokens: a.tokens })),
    mcpTools: c.mcpTools.map((t) => ({ name: t.name, server: t.serverName, tokens: t.tokens, loaded: t.isLoaded })),
    toolTokens: c.messageBreakdown
      ? c.messageBreakdown.toolCallsByType.map((t) => ({ name: t.name, tokens: t.callTokens + t.resultTokens })).sort((a, b) => b.tokens - a.tokens)
      : [],
  };
}

/** What a tool returned, at roughly 4 characters a token; images aren't counted. */
function approxTokens(content: unknown): number | undefined {
  let chars = 0;
  if (typeof content === "string") chars = content.length;
  else if (Array.isArray(content)) {
    for (const part of content as Array<{ type?: string; text?: unknown }>) if (part.type === "text" && typeof part.text === "string") chars += part.text.length;
  } else return undefined;
  return Math.ceil(chars / 4);
}

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
 * that with the context size shortened ("Opus 5.5 1M"), else build one from the
 * resolved id ("claude-haiku-4-5-20251001" → "Haiku 4.5"). The tooltip keeps the full text.
 */
function versionedName(m: Sdk.ModelInfo): string {
  const head = m.description ? m.description.split(" · ")[0].replace(/ with (\S+) context$/i, " $1").trim() : "";
  if (head && /\d/.test(head)) return head;
  const id = m.resolvedModel || m.value;
  const match = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!match) return m.displayName;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `${family} ${match[2].replace(/-/g, ".")}${match[3] ? " 1M" : ""}`;
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
