import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as readline from "readline";
import type { ApprovalDecision, ModelInfo, PendingApproval, ProviderInfo, ProviderUsage, ToolEvent, UsageWindow } from "../api/types";
import type { ProviderAdapter, TurnResult, TurnSink, TurnTarget } from "./adapter";
import { findExecutable } from "./binaries";

// -- the slice of the app-server protocol we use (see `codex app-server generate-ts`) --

interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
  rateLimitResetCredits: { availableCount: number } | null;
}

type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; status: string; exitCode: number | null }
  | { type: "fileChange"; id: string; status: string; changes: Array<{ path: string; kind: { type: string }; diff: string }> }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string }
  | { type: "dynamicToolCall"; id: string; tool: string; status: string; success: boolean | null }
  | { type: "webSearch"; id: string; query?: string }
  | { type: string; id: string };

interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The "Auto" preset in Codex's /approvals: work freely in the workspace, ask for anything beyond it. */
const AUTO = { approvalPolicy: "on-request", sandbox: "workspace-write" } as const;
/** Ask mode: the sandbox allows reading only, and nothing may ask to go beyond it. */
const READ_ONLY = { approvalPolicy: "never", sandbox: "read-only" } as const;

/**
 * A turn's sandbox carries over to the thread's later turns, so every turn sets
 * its own. These match the presets above.
 */
const TURN_AUTO = {
  approvalPolicy: AUTO.approvalPolicy,
  sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};
const TURN_READ_ONLY = { approvalPolicy: READ_ONLY.approvalPolicy, sandboxPolicy: { type: "readOnly", networkAccess: false } };

// -- JSON-RPC over the app-server's stdio, one JSON object per line ----------

class AppServer {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderr: string[] = [];
  readonly exited: Promise<string>;

  constructor(
    executable: string,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.proc = spawn(executable, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.receive(line));
    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderr.push(d.toString());
      if (this.stderr.length > 20) this.stderr.shift();
    });
    this.exited = new Promise((resolve) => {
      const done = (why: string) => {
        const reason = `Codex stopped (${why}). ${this.stderr.join("").trim().split("\n").slice(-3).join(" ")}`.trim();
        for (const p of this.pending.values()) p.reject(new Error(reason));
        this.pending.clear();
        resolve(reason);
      };
      this.proc.on("exit", (code) => done(`exit ${code}`));
      this.proc.on("error", (err) => done(err.message));
    });
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string): void {
    this.send({ method });
  }

  kill(): void {
    this.proc.kill();
  }

  private send(msg: unknown): void {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private receive(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // A request from Codex to us (approvals and the like).
      const id = msg.id;
      this.onRequest(msg.method, msg.params || {}).then(
        (result) => this.send({ id, result }),
        (err: Error) => this.send({ id, error: { code: -32000, message: err.message } }),
      );
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params || {});
    } else if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
}

// -- the adapter ----------------------------------------------------------------

interface ActiveTurn {
  sessionId: string;
  cwd: string;
  sink: TurnSink;
  turnId?: string;
  wroteText: boolean;
  /** File changes by item id, to describe them when Codex asks to apply them. */
  fileChanges: Map<string, string[]>;
  error?: string;
  finish: (turn: Turn) => void;
}

/**
 * Codex through `codex app-server`: one long-lived process for all sessions,
 * each session a Codex thread. Uses the installed `codex`, so its login,
 * config and model catalogue apply.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private server: Promise<AppServer> | undefined;
  /** Threads the current process has started or resumed; others must be resumed first. */
  private loaded = new Set<string>();
  /** Running turn per thread id. */
  private active = new Map<string, ActiveTurn>();
  private threadOf = new Map<string, string>();
  private models: CodexModel[] = [];
  private rateLimits: RateLimitsResponse | undefined;
  private usageError: string | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly pathOverride: () => string | undefined) {}

  // -- catalogue and usage -------------------------------------------------

  async info(): Promise<ProviderInfo> {
    const server = await this.connect();
    const all: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: CodexModel[]; nextCursor: string | null } = await server.request("model/list", { cursor });
      all.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    this.models = all.filter((m) => !m.hidden).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return { id: "codex", label: "Codex", models: this.models.map(toModel) };
  }

  async usage(): Promise<ProviderUsage | undefined> {
    const server = await this.connect();
    try {
      this.rateLimits = await server.request<RateLimitsResponse>("account/rateLimits/read", {});
      this.usageError = undefined;
    } catch (err) {
      this.usageError = err instanceof Error ? err.message : String(err);
    }
    return this.currentUsage();
  }

  onDidChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private currentUsage(): ProviderUsage {
    const now = Date.now();
    if (!this.rateLimits) {
      const note = this.usageError && /chatgpt/i.test(this.usageError) ? "Plan limits need a ChatGPT sign-in (codex login), not an API key." : this.usageError;
      return { provider: "codex", windows: [], note, updatedAt: now };
    }
    return toUsage(this.rateLimits, now);
  }

  // -- turns ---------------------------------------------------------------

  async runTurn(target: TurnTarget, text: string, sink: TurnSink): Promise<TurnResult> {
    const server = await this.connect();
    const model = this.models.find((m) => m.model === target.options.model);
    const effort = model && model.supportedReasoningEfforts.some((e) => e.reasoningEffort === target.options.effort) ? target.options.effort : undefined;
    const settings = { model: target.options.model, cwd: target.cwd, ...(target.readOnly ? READ_ONLY : AUTO) };

    let threadId: string;
    if (target.forkOf) {
      const res = await server.request<{ thread: { id: string } }>("thread/fork", {
        threadId: target.forkOf.providerSessionId,
        lastTurnId: target.forkOf.atProviderMessageId || null,
        ...settings,
      });
      threadId = res.thread.id;
    } else if (target.providerSessionId && this.loaded.has(target.providerSessionId)) {
      threadId = target.providerSessionId;
    } else if (target.providerSessionId) {
      const res = await server.request<{ thread: { id: string } }>("thread/resume", { threadId: target.providerSessionId, ...settings });
      threadId = res.thread.id;
    } else {
      const res = await server.request<{ thread: { id: string } }>("thread/start", settings);
      threadId = res.thread.id;
    }
    this.loaded.add(threadId);
    this.threadOf.set(target.sessionId, threadId);
    sink.providerSessionId(threadId);

    const finished = new Promise<Turn>((resolve) => {
      this.active.set(threadId, { sessionId: target.sessionId, cwd: target.cwd, sink, wroteText: false, fileChanges: new Map(), finish: resolve });
    });
    try {
      const started = await server.request<{ turn: Turn }>("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        model: target.options.model,
        ...(effort ? { effort } : {}),
        ...(target.readOnly ? TURN_READ_ONLY : TURN_AUTO),
      });
      const turn = this.active.get(threadId);
      if (turn) turn.turnId = started.turn.id;
      const exited = server.exited.then((reason): Turn => ({ id: "", status: "failed", error: { message: reason } }));
      const result = await Promise.race([finished, exited]);
      const error = (this.active.get(threadId) || { error: undefined }).error;
      if (result.status === "failed") return { ok: false, error: (result.error && result.error.message) || error || "Codex failed the turn." };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.active.delete(threadId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const threadId = this.threadOf.get(sessionId);
    const turn = threadId ? this.active.get(threadId) : undefined;
    if (!threadId || !turn || !turn.turnId || !this.server) return;
    const server = await this.server;
    await server.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => undefined);
    // Wait (briefly) for Codex to confirm, so the next turn starts on a settled thread.
    const deadline = Date.now() + 5000;
    while (this.active.has(threadId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  dispose(): void {
    if (this.server) void this.server.then((s) => s.kill(), () => undefined);
    this.server = undefined;
    this.listeners.clear();
  }

  // -- the process ---------------------------------------------------------

  private connect(): Promise<AppServer> {
    if (!this.server) {
      const starting = this.start();
      this.server = starting;
      starting.catch(() => {
        if (this.server === starting) this.server = undefined;
      });
    }
    return this.server;
  }

  private async start(): Promise<AppServer> {
    const executable = findExecutable("codex", this.pathOverride());
    if (!executable) throw new Error("Codex isn't installed. Install it, or set relay.codexPath.");
    const server = new AppServer(
      executable,
      (method, params) => this.notification(method, params),
      (method, params) => this.request(method, params),
    );
    void server.exited.then(() => {
      // Start a fresh process on next use; nothing it had loaded survives.
      this.server = undefined;
      this.loaded.clear();
    });
    await server.request("initialize", { clientInfo: { name: "relay", title: "Relay", version: "0.0.1" }, capabilities: null });
    server.notify("initialized");
    return server;
  }

  private notification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      this.rateLimits = { ...(this.rateLimits || { rateLimitsByLimitId: null, rateLimitResetCredits: null }), rateLimits: params.rateLimits as RateLimitSnapshot };
      if (this.rateLimits.rateLimitsByLimitId) {
        const snap = params.rateLimits as RateLimitSnapshot;
        this.rateLimits.rateLimitsByLimitId[snap.limitId || "codex"] = snap;
      }
      for (const l of this.listeners) l();
      return;
    }
    const turn = typeof params.threadId === "string" ? this.active.get(params.threadId) : undefined;
    if (!turn) return;
    const { sink } = turn;
    switch (method) {
      case "item/agentMessage/delta":
        sink.text(String(params.delta || ""));
        turn.wroteText = true;
        break;
      case "item/started":
      case "item/completed": {
        const item = params.item as ThreadItem;
        if (item.type === "agentMessage") {
          if (method === "item/started" && turn.wroteText) sink.text("\n\n");
          if (method === "item/completed" && turn.turnId) sink.checkpoint(turn.turnId);
          break;
        }
        for (const row of toolRows(item, turn.cwd)) {
          sink.tool(row);
          turn.wroteText = false;
        }
        if (item.type === "fileChange" && "changes" in item) {
          turn.fileChanges.set(item.id, item.changes.map((c) => rel(turn.cwd, c.path)));
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as { last: { totalTokens: number }; modelContextWindow: number | null };
        if (usage.modelContextWindow) sink.context({ usedTokens: usage.last.totalTokens, limitTokens: usage.modelContextWindow });
        break;
      }
      case "error": {
        const p = params as { error: { message: string }; willRetry: boolean };
        if (!p.willRetry) turn.error = p.error.message;
        break;
      }
      case "turn/completed":
        turn.finish(params.turn as Turn);
        break;
    }
  }

  /** Codex asking us something: approvals go to the card; anything we can't show is declined. */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const turn = typeof params.threadId === "string" ? this.active.get(params.threadId) : undefined;
    if (method === "item/commandExecution/requestApproval") {
      const p = params as { command?: string | null; reason?: string | null };
      if (!turn) return { decision: "decline" };
      const answer = await turn.sink.approval({ kind: "bash", summary: p.reason || "wants to run a command", detail: p.command || "" });
      return { decision: toDecision(answer) };
    }
    if (method === "item/fileChange/requestApproval") {
      const p = params as { itemId: string; reason?: string | null; grantRoot?: string | null };
      if (!turn) return { decision: "decline" };
      const files = turn.fileChanges.get(p.itemId) || [];
      const request: PendingApproval = {
        kind: "edit",
        summary: p.reason || (p.grantRoot ? `wants to write outside the workspace` : "wants to change files"),
        detail: p.grantRoot || files.join(", ") || "files",
      };
      const answer = await turn.sink.approval(request);
      return { decision: toDecision(answer) };
    }
    throw new Error(`Relay can't answer ${method} yet.`);
  }
}

// -- mapping ----------------------------------------------------------------------

function toModel(m: CodexModel): ModelInfo {
  return {
    id: m.model,
    label: m.displayName,
    description: [m.description, m.model].filter(Boolean).join("\n"),
    efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort,
  };
}

function toDecision(answer: ApprovalDecision): string {
  return answer === "allow" ? "accept" : answer === "always" ? "acceptForSession" : "decline";
}

const PLAN_NAMES: Record<string, string> = { prolite: "Pro Lite", pro: "Pro", plus: "Plus", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

/** Codex's /status labels a window by its length. */
function windowLabel(mins: number | null): string {
  if (mins === 300) return "5h limit";
  if (mins === 10080) return "Weekly limit";
  if (mins === 1440) return "Daily limit";
  if (!mins) return "Limit";
  if (mins % 1440 === 0) return `${mins / 1440}d limit`;
  if (mins % 60 === 0) return `${mins / 60}h limit`;
  return `${mins}m limit`;
}

function toUsage(r: RateLimitsResponse, now: number): ProviderUsage {
  const snapshots = r.rateLimitsByLimitId ? Object.values(r.rateLimitsByLimitId).filter((s): s is RateLimitSnapshot => !!s) : [r.rateLimits];
  const windows: UsageWindow[] = [];
  for (const snap of snapshots) {
    // Extra metered buckets are shown as "<name> 5h limit", as /status does.
    const prefix = snap.limitId && snap.limitId !== "codex" ? `${snap.limitName || snap.limitId} ` : "";
    for (const [slot, w] of [["primary", snap.primary], ["secondary", snap.secondary]] as const) {
      if (!w) continue;
      windows.push({
        id: `${snap.limitId || "codex"}:${slot}`,
        label: prefix + windowLabel(w.windowDurationMins),
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
      });
    }
  }
  const extras: Array<{ label: string; value: string }> = [];
  const credits = r.rateLimits.credits;
  if (credits && (credits.unlimited || credits.hasCredits)) extras.push({ label: "Credits", value: credits.unlimited ? "unlimited" : `${credits.balance || 0} left` });
  if (r.rateLimitResetCredits && r.rateLimitResetCredits.availableCount > 0) {
    extras.push({ label: "Limit resets", value: `${r.rateLimitResetCredits.availableCount} available` });
  }
  const planType = r.rateLimits.planType;
  return { provider: "codex", plan: planType ? PLAN_NAMES[planType] || planType : undefined, windows, extras, updatedAt: now };
}

function rel(cwd: string, file: string): string {
  const r = path.relative(cwd, file);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : file;
}

/** "+"/"-" lines of a unified diff, without the file headers. */
function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function toolRows(item: ThreadItem, cwd: string): ToolEvent[] {
  const done = (status: string) => (status === "inProgress" ? undefined : status === "completed");
  switch (item.type) {
    case "commandExecution": {
      const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
      const ok = done(it.status);
      const detail = it.status === "declined" ? "declined" : it.exitCode !== null ? `exit ${it.exitCode}` : it.status === "failed" ? "failed" : undefined;
      return [{ id: it.id, kind: "run", label: "Ran", target: it.command.split("\n")[0], ok: ok === undefined ? undefined : ok && it.exitCode === 0, detail }];
    }
    case "fileChange": {
      const it = item as Extract<ThreadItem, { type: "fileChange" }>;
      return it.changes.map((c, i) => {
        const kind = c.kind.type;
        const counts = diffCounts(c.diff);
        // A created or deleted file comes as its plain content, not +/- lines.
        const lines = c.diff ? c.diff.replace(/\n$/, "").split("\n").length : 0;
        if (kind === "add" && !counts.added) counts.added = lines;
        if (kind === "delete" && !counts.removed) counts.removed = lines;
        return {
          id: `${it.id}:${i}`,
          kind: kind === "add" ? ("write" as const) : ("edit" as const),
          label: kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited",
          target: rel(cwd, c.path),
          path: path.isAbsolute(c.path) ? c.path : path.join(cwd, c.path),
          added: counts.added,
          removed: counts.removed,
          ok: done(it.status),
          detail: it.status === "declined" ? "declined" : undefined,
        };
      });
    }
    case "mcpToolCall": {
      const it = item as Extract<ThreadItem, { type: "mcpToolCall" }>;
      return [{ id: it.id, kind: "other", label: "Used", target: `${it.server}.${it.tool}`, ok: done(it.status) }];
    }
    case "dynamicToolCall": {
      const it = item as Extract<ThreadItem, { type: "dynamicToolCall" }>;
      return [{ id: it.id, kind: "other", label: "Used", target: it.tool, ok: it.success === null ? undefined : it.success }];
    }
    case "webSearch": {
      const it = item as Extract<ThreadItem, { type: "webSearch" }>;
      return [{ id: it.id, kind: "other", label: "Searched web", target: it.query || "" }];
    }
    default:
      return [];
  }
}
