import type { SessionsApi, Unsubscribe } from "../api/SessionsApi";
import {
  isActive,
  minutesLabel,
  workDir,
  type Answers,
  type ApprovalDecision,
  type Delivery,
  type Message,
  type MessageMode,
  type ProviderId,
  type ProviderInfo,
  type ProviderUsage,
  type Session,
  type SessionInspect,
  type SessionOptions,
  type Worktree,
} from "../api/types";
import type { ProviderAdapter, TurnSink, TurnTarget } from "./adapter";
import type { SessionStore } from "./store";
import type { Titler } from "./titles";
import { createWorktree, mergeWorktree } from "./worktree";

const MODELS_REFRESH_MS = 30 * 60 * 1000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const RUN_LIMIT_CHECK_MS = 1000;
/** The inspector keeps this many tool calls and events per session, dropping the oldest. */
const INSPECT_MAX_TOOLS = 2000;
const INSPECT_MAX_EVENTS = 500;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** A normal message leaves the mode out. */
function stored(mode: MessageMode | undefined): MessageMode | undefined {
  return mode === "normal" ? undefined : mode;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 48 ? line.slice(0, 45) + "…" : line;
}

/**
 * The session rules (unread, complete, queue, forks) on top of one adapter per
 * provider. The mock backend is this same class with fake adapters.
 */
export class RealSessionsApi implements SessionsApi {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();
  private providers: ProviderInfo[] = [];
  private providersLoading: Promise<void> | undefined;
  private usage: ProviderUsage[] = [];
  private listeners = new Set<() => void>();
  /** Current turn per session; events from an interrupted turn are dropped. */
  private turns = new Map<string, number>();
  private turnSeq = 0;
  /** Settles when the session's current turn has fully ended. */
  private running = new Map<string, Promise<void>>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private answers = new Map<string, (a: Answers | undefined) => void>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  /** Latest title request per session; an older answer arriving late is dropped. */
  private titleRequests = new Map<string, number>();
  /** Sessions whose worktree is being merged back right now. */
  private merging = new Set<string>();
  /** Sessions resolving merge conflicts; completed again once that turn ends. */
  private mergeRetries = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    adapters: ProviderAdapter[],
    private readonly titler?: Titler,
    /** Added to the end of a message sent in plan or ask mode. */
    private readonly modePrompt: (mode: MessageMode) => string = () => "",
    /** Opens Relay's browser for an agent if needed and returns its DevTools address. */
    private readonly openBrowser?: () => Promise<string>,
  ) {
    for (const a of adapters) {
      this.adapters.set(a.id, a);
      a.onDidChange(() => void this.refreshUsage());
    }
    this.providersLoading = this.refreshProviders();
    void this.refreshUsage();
    this.timers.push(setInterval(() => void this.refreshProviders(), MODELS_REFRESH_MS));
    this.timers.push(setInterval(() => void this.refreshUsage(), USAGE_REFRESH_MS));
    this.timers.push(setInterval(() => this.enforceRunLimits(), RUN_LIMIT_CHECK_MS));
  }

  // -- reads ---------------------------------------------------------------

  async listProviders(): Promise<ProviderInfo[]> {
    if (this.providersLoading) await this.providersLoading;
    return this.providers;
  }

  async getUsage(): Promise<ProviderUsage[]> {
    return this.usage;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.store.sessions.values()].map((s) => ({
      ...s,
      queued: s.queued.map((q) => ({ ...q })),
      context: s.context ? { ...s.context } : undefined,
      tokens: s.tokens ? { ...s.tokens } : undefined,
    }));
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.store.messagesOf(sessionId).map((m) => ({ ...m, tools: m.tools ? m.tools.map((t) => ({ ...t })) : undefined }));
  }

  async getInspect(sessionId: string): Promise<SessionInspect | undefined> {
    const i = this.store.inspects.get(sessionId);
    return i ? { ...i, tools: i.tools.slice(), events: i.events.slice() } : undefined;
  }

  // -- writes --------------------------------------------------------------

  async createSession(options: SessionOptions, cwd: string, useWorktree?: boolean, scheduledTaskId?: string): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      id: nextId("s"),
      title: "New session",
      status: "done",
      options,
      cwd,
      folder: cwd.split(/[\\/]/).pop() || cwd,
      createdAt: now,
      lastActivityAt: now,
      unread: false,
      archived: false,
      queued: [],
      transcriptPath: "",
      useWorktree: useWorktree || undefined,
      scheduledTaskId,
    };
    // A new session is a good moment to pick up models released since the last look.
    void this.refreshProviders();
    this.store.put(session);
    this.emit();
    return session;
  }

  async sendMessage(sessionId: string, text: string, options?: Partial<SessionOptions>, delivery: Delivery = "queue", mode?: MessageMode): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    if (options) {
      // Another provider can't resume this one's conversation; it starts fresh.
      if (options.provider && options.provider !== session.options.provider) {
        session.providerSessionId = undefined;
        session.forkOf = undefined;
      }
      session.options = { ...session.options, ...options };
    }
    if (isActive(session)) {
      if (delivery === "queue") {
        session.queued.push({ id: nextId("q"), text, createdAt: Date.now(), mode: stored(mode) });
        this.emit();
        return;
      }
      await this.interrupt(session);
    }
    this.startTurn(session, text, false, mode);
  }

  async removeQueued(sessionId: string, queuedId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.queued = session.queued.filter((q) => q.id !== queuedId);
    this.emit();
  }

  async forkSession(sessionId: string, fromMessageId?: string): Promise<Session> {
    const parent = this.store.sessions.get(sessionId);
    if (!parent) throw new Error(`No session ${sessionId}`);
    const parentMessages = this.store.messagesOf(sessionId);
    const cut = fromMessageId ? parentMessages.findIndex((m) => m.id === fromMessageId) : parentMessages.length - 1;
    const kept = parentMessages.slice(0, cut + 1).map((m) => ({ ...m, streaming: false }));
    const lastAssistant = [...kept].reverse().find((m) => m.role === "assistant" && m.providerMessageId);
    const now = Date.now();
    const fork: Session = {
      ...parent,
      id: nextId("s"),
      title: `Fork of ${parent.title}`,
      status: "done",
      createdAt: now,
      lastActivityAt: now,
      unread: false,
      archived: false,
      queued: [],
      parentId: parent.id,
      forkedFromMessageId: kept.length ? kept[kept.length - 1].id : undefined,
      forkedFromIndex: kept.length,
      pendingApproval: undefined,
      pendingQuestions: undefined,
      scheduledTaskId: undefined,
      // A fork counts only what it spends itself.
      tokens: undefined,
      providerSessionId: undefined,
      forkOf: parent.providerSessionId
        ? { providerSessionId: parent.providerSessionId, atProviderMessageId: fromMessageId && lastAssistant ? lastAssistant.providerMessageId : undefined }
        : undefined,
    };
    this.store.put(fork, kept);
    // The inspector keeps what happened up to where the fork branches off.
    const parentInspect = this.store.inspects.get(parent.id);
    if (parentInspect) {
      const dropped = parentMessages[cut + 1];
      const before = (at: number) => !dropped || at < dropped.createdAt;
      this.store.inspects.set(fork.id, {
        setup: parentInspect.setup,
        tools: parentInspect.tools.filter((t) => before(t.startedAt)),
        events: parentInspect.events.filter((e) => before(e.at)),
      });
    }
    this.emit();
    return fork;
  }

  async createSubsession(parentId: string, options: SessionOptions, title: string): Promise<Session> {
    const parent = this.store.sessions.get(parentId);
    if (!parent) throw new Error(`No session ${parentId}`);
    const now = Date.now();
    const child: Session = {
      id: nextId("s"),
      title,
      status: "done",
      options,
      cwd: parent.cwd,
      folder: parent.folder,
      createdAt: now,
      lastActivityAt: now,
      unread: false,
      archived: false,
      queued: [],
      transcriptPath: "",
      parentId: parent.id,
      useWorktree: parent.useWorktree,
      worktree: parent.worktree,
    };
    this.store.put(child);
    this.emit();
    return child;
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session || !isActive(session)) return;
    await this.interrupt(session);
    session.lastActivityAt = Date.now();
    this.emit();
  }

  async respondToApproval(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const resolve = this.approvals.get(sessionId);
    if (resolve) resolve(decision);
  }

  async answerQuestions(sessionId: string, answers: Answers | undefined): Promise<void> {
    const resolve = this.answers.get(sessionId);
    if (resolve) resolve(answers);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.title = title;
    this.emit();
  }

  async setBrowserAccess(sessionId: string, on: boolean): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.browserAccess = on || undefined;
    this.emit();
  }

  async setRunLimit(sessionId: string, limitMs: number | undefined): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    session.runLimitMs = limitMs;
    this.emit();
  }

  async markSeen(sessionId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (!session || !session.unread) return;
    session.unread = false;
    session.seenAt = Date.now();
    this.emit();
  }

  async archiveSession(sessionId: string): Promise<void> {
    const session = this.store.sessions.get(sessionId);
    if (session && session.worktree && !isActive(session) && !(await this.mergeBack(session, session.worktree))) return;
    const archive = (id: string) => {
      const s = this.store.sessions.get(id);
      if (!s) return;
      if (!isActive(s)) {
        s.archived = true;
        s.unread = false;
      }
      for (const child of this.store.sessions.values()) if (child.parentId === id) archive(child.id);
    };
    archive(sessionId);
    this.emit();
  }

  onDidChange(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    for (const a of this.adapters.values()) a.dispose();
    this.listeners.clear();
    void this.store.flush();
  }

  // -- turns ---------------------------------------------------------------

  /** `continuing` is a queued follow-up, which stays part of the same run. */
  private startTurn(session: Session, text: string, continuing = false, mode?: MessageMode): void {
    const list = this.store.messagesOf(session.id);
    if (!list.some((m) => m.role === "user")) session.title = titleFrom(text);
    void this.retitle(session, text);
    list.push({ id: nextId("m"), role: "user", text, createdAt: Date.now(), mode: stored(mode) });
    for (let s: Session | undefined = session; s; s = s.parentId ? this.store.sessions.get(s.parentId) : undefined) {
      s.archived = false;
    }
    session.unread = false;
    session.status = "running";
    session.lastActivityAt = Date.now();
    if (!continuing) session.runStartedAt = session.lastActivityAt;
    this.emit();

    const turn = ++this.turnSeq;
    this.turns.set(session.id, turn);
    const live = () => this.turns.get(session.id) === turn;
    const instruction = mode && mode !== "normal" ? this.modePrompt(mode).trim() : "";
    const done = this.runTurn(session, instruction ? `${text}\n\n${instruction}` : text, live, mode === "ask").catch((err: unknown) => {
      if (live()) this.endTurn(session, `Error: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.running.set(session.id, done);
  }

  private async runTurn(session: Session, text: string, live: () => boolean, readOnly: boolean): Promise<void> {
    const adapter = this.adapters.get(session.options.provider);
    if (!adapter) throw new Error(`No backend for ${session.options.provider}`);
    const list = this.store.messagesOf(session.id);
    let current: Message | undefined;
    const assistant = (): Message => {
      if (!current) {
        current = { id: nextId("m"), role: "assistant", text: "", createdAt: Date.now(), streaming: true, tools: [] };
        list.push(current);
      }
      return current;
    };
    const activity = () => {
      session.lastActivityAt = Date.now();
      this.emit();
    };

    const sink: TurnSink = {
      providerSessionId: (id) => {
        if (!live()) return;
        session.providerSessionId = id;
        session.forkOf = undefined;
        this.emit();
      },
      text: (delta) => {
        if (!live()) return;
        assistant().text += delta;
        activity();
      },
      tool: (event) => {
        if (!live()) return;
        let m = assistant();
        const tools = m.tools || (m.tools = []);
        const i = tools.findIndex((t) => t.id === event.id);
        if (i >= 0) tools[i] = { ...tools[i], ...event };
        else {
          // Tools render above text, so a tool after text opens a new message.
          if (m.text) {
            m.streaming = false;
            current = undefined;
            m = assistant();
          }
          (m.tools || (m.tools = [])).push(event);
        }
        activity();
      },
      approval: (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          if (!live()) return resolve("deny");
          session.status = "waiting";
          session.pendingApproval = request;
          this.approvals.set(session.id, (decision) => {
            this.approvals.delete(session.id);
            session.pendingApproval = undefined;
            if (live()) session.status = "running";
            activity();
            resolve(decision);
          });
          activity();
        }),
      questions: (questions) =>
        new Promise<Answers | undefined>((resolve) => {
          if (!live()) return resolve(undefined);
          session.status = "waiting";
          session.pendingQuestions = questions;
          this.answers.set(session.id, (answers) => {
            this.answers.delete(session.id);
            session.pendingQuestions = undefined;
            if (live()) session.status = "running";
            activity();
            resolve(answers);
          });
          activity();
        }),
      context: (usage) => {
        if (!live()) return;
        session.context = usage;
        this.emit();
      },
      tokens: (delta) => {
        if (!live()) return;
        const t = session.tokens || (session.tokens = { input: 0, cachedInput: 0, output: 0 });
        t.input += delta.input || 0;
        t.cachedInput += delta.cachedInput || 0;
        t.output += delta.output || 0;
        this.emit();
      },
      checkpoint: (providerMessageId) => {
        if (!live()) return;
        const target = current || [...list].reverse().find((m) => m.role === "assistant");
        if (target) target.providerMessageId = providerMessageId;
      },
      inspect: (update) => {
        if (!live()) return;
        const i = this.store.inspectOf(session.id);
        if (update.setup) i.setup = update.setup;
        if (update.context) i.context = update.context;
        if (update.turn) {
          const t = update.turn;
          const prev = i.stats || { turns: 0, roundTrips: 0, durationMs: 0, apiDurationMs: 0, costUsd: 0, models: [] };
          i.stats = {
            turns: prev.turns + 1,
            roundTrips: prev.roundTrips + t.roundTrips,
            durationMs: prev.durationMs + t.durationMs,
            apiDurationMs: prev.apiDurationMs + t.apiDurationMs,
            costUsd: t.costUsd,
            models: t.models,
          };
        }
        const tool = update.tool;
        if (tool) {
          const k = i.tools.findIndex((t) => t.id === tool.id);
          // Replaced rather than changed in place: a copy handed out by getInspect stays as it was.
          if (k >= 0) i.tools[k] = { ...i.tools[k], ...tool };
          else i.tools.push({ name: "", kind: "other", label: "", target: "", startedAt: Date.now(), ...tool });
          if (i.tools.length > INSPECT_MAX_TOOLS) i.tools.splice(0, i.tools.length - INSPECT_MAX_TOOLS);
        }
        if (update.event) {
          i.events.push(update.event);
          if (i.events.length > INSPECT_MAX_EVENTS) i.events.splice(0, i.events.length - INSPECT_MAX_EVENTS);
        }
        this.emit();
      },
    };

    if (session.useWorktree && !session.worktree) {
      session.worktree = await createWorktree(session.cwd, session.id, session.title);
      this.emit();
    }
    // Ask mode can't change anything, so it doesn't get a browser to click around in.
    let browserUrl: string | undefined;
    if (session.browserAccess && !readOnly && this.openBrowser) {
      try {
        browserUrl = await this.openBrowser();
      } catch (err) {
        this.note(session, `The agent works without Relay's browser this turn: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!live()) return;
    }
    const target: TurnTarget = {
      sessionId: session.id,
      cwd: workDir(session),
      options: session.options,
      providerSessionId: session.providerSessionId,
      forkOf: session.forkOf,
      readOnly,
      browserUrl,
    };
    const result = await adapter.runTurn(target, text, sink);
    if (!live()) return;
    if (current) current.streaming = false;
    this.endTurn(session, result.ok ? undefined : result.error || "The turn failed.");
    void this.refreshUsage();
  }

  /** The turn ended on its own: start the next queued message, or settle and flag it unread. */
  private endTurn(session: Session, error?: string): void {
    this.turns.delete(session.id);
    const list = this.store.messagesOf(session.id);
    for (const m of list) m.streaming = false;
    if (error) list.push({ id: nextId("m"), role: "assistant", text: error, createdAt: Date.now() });
    const next = error ? undefined : session.queued.shift();
    if (next) return this.startTurn(session, next.text, true, next.mode);
    session.status = error ? "failed" : "done";
    session.unread = true;
    session.lastActivityAt = Date.now();
    this.emit();
    if (this.mergeRetries.has(session.id)) {
      if (error) this.mergeRetries.delete(session.id);
      else void this.archiveSession(session.id);
    }
  }

  /** Stops the running turn and waits for the provider to let go, without flagging it unread. */
  private async interrupt(session: Session): Promise<void> {
    this.turns.delete(session.id);
    this.mergeRetries.delete(session.id);
    const resolve = this.approvals.get(session.id);
    if (resolve) resolve("deny");
    const answer = this.answers.get(session.id);
    if (answer) answer(undefined);
    session.pendingApproval = undefined;
    session.pendingQuestions = undefined;
    const list = this.store.messagesOf(session.id);
    const last = list[list.length - 1];
    if (last && last.role === "assistant" && last.streaming) last.text = last.text ? `${last.text} [interrupted]` : "[interrupted]";
    for (const m of list) m.streaming = false;
    session.status = "done";
    this.emit();
    const adapter = this.adapters.get(session.options.provider);
    if (adapter) await adapter.interrupt(session.id);
    const running = this.running.get(session.id);
    if (running) await running;
  }

  /** Retitles the session after its latest message, falling back to the message's first line. */
  private async retitle(session: Session, text: string): Promise<void> {
    const request = (this.titleRequests.get(session.id) || 0) + 1;
    this.titleRequests.set(session.id, request);
    const title = this.titler ? await this.titler(text, session.title).catch(() => undefined) : undefined;
    if (this.titleRequests.get(session.id) !== request) return;
    session.title = title || titleFrom(text);
    this.emit();
  }

  private enforceRunLimits(): void {
    const now = Date.now();
    for (const s of this.store.sessions.values()) {
      if (isActive(s) && s.runLimitMs && s.runStartedAt && now - s.runStartedAt >= s.runLimitMs) void this.stopAtLimit(s, s.runLimitMs);
    }
  }

  /** Like a stop, but flagged unread with a note, since the user likely wasn't watching. */
  private async stopAtLimit(session: Session, limitMs: number): Promise<void> {
    await this.interrupt(session);
    const text = `Stopped: reached the ${minutesLabel(limitMs)} time limit.`;
    this.store.messagesOf(session.id).push({ id: nextId("m"), role: "assistant", text, createdAt: Date.now() });
    session.unread = true;
    session.lastActivityAt = Date.now();
    this.emit();
  }

  /**
   * Merges the session's worktree into the branch it started from. On a
   * conflict the agent is asked to resolve it once, and the session completes
   * when it's done; otherwise it stays open with a note saying why.
   */
  private async mergeBack(session: Session, wt: Worktree): Promise<boolean> {
    if (this.merging.has(session.id)) return false;
    const sharing = [...this.store.sessions.values()].filter((s) => s.worktree && s.worktree.path === wt.path);
    if (sharing.some(isActive)) {
      this.note(session, "A fork is still working in this worktree. Complete again once it's done.");
      return false;
    }
    const retry = this.mergeRetries.delete(session.id);
    this.merging.add(session.id);
    const result = await mergeWorktree(session.cwd, wt, session.title).finally(() => this.merging.delete(session.id));
    if (result.ok) {
      for (const s of sharing) {
        s.worktree = undefined;
        s.useWorktree = undefined;
      }
      this.note(session, result.merged ? `Merged ${wt.branch} into ${wt.base} and removed the worktree.` : `No changes to merge; removed the worktree and ${wt.branch}.`);
      return true;
    }
    if ("conflicts" in result) {
      const files = result.conflicts.join(", ");
      if (retry) {
        this.note(session, `${wt.branch} still conflicts with ${wt.base} in ${files}. Resolve them in the worktree, then complete again.`);
        return false;
      }
      this.mergeRetries.add(session.id);
      this.startTurn(
        session,
        `Completing this session merges your branch ${wt.branch} into ${wt.base}, but ${wt.base} has changed since and conflicts in: ${files}. Run \`git merge ${wt.base}\`, resolve the conflicts and commit the merge.`,
      );
      return false;
    }
    this.note(session, `Couldn't merge ${wt.branch} into ${wt.base}: ${result.error}`);
    return false;
  }

  private note(session: Session, text: string): void {
    this.store.messagesOf(session.id).push({ id: nextId("m"), role: "assistant", text, createdAt: Date.now() });
    session.lastActivityAt = Date.now();
    this.emit();
  }

  // -- catalogue and usage -------------------------------------------------

  private async refreshProviders(): Promise<void> {
    this.providers = await Promise.all(
      [...this.adapters.values()].map((a) =>
        a.info().catch((err: unknown): ProviderInfo => ({
          id: a.id,
          label: a.id === "claude" ? "Claude" : "Codex",
          models: [],
          unavailable: err instanceof Error ? err.message : String(err),
        })),
      ),
    );
    this.providersLoading = undefined;
    this.emit();
  }

  private async refreshUsage(): Promise<void> {
    const all = await Promise.all([...this.adapters.values()].map((a) => a.usage().catch(() => undefined)));
    this.usage = all.filter((u): u is ProviderUsage => !!u);
    this.emit();
  }

  private emit(): void {
    this.store.save();
    for (const l of this.listeners) l();
  }
}
