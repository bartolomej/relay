import * as fs from "fs/promises";
import * as path from "path";
import type { SessionsApi } from "../api/SessionsApi";
import { nextRun } from "../api/schedule";
import { isActive, type Repeat, type ScheduledTask, type TaskInput } from "../api/types";
import { isGitRepo } from "./worktree";

const CHECK_MS = 30 * 1000;
const REPEATS: Repeat[] = ["daily", "weekdays", "weekly", "monthly"];

/** Saved as `.relay/schedules.json` in the project. */
interface TasksFile {
  version: 1;
  tasks: ScheduledTask[];
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Prompts that start a new session on a schedule. It only runs while this
 * project is open in VS Code; a run that came due while it wasn't (VS Code
 * closed, the Mac asleep) starts once as soon as it's back. With no file it
 * keeps tasks in memory only, as the mock uses it.
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;

  constructor(
    private readonly api: SessionsApi,
    /** The project folder runs work in. */
    private readonly cwd: string,
    private readonly file?: string,
  ) {}

  async start(): Promise<void> {
    await this.load();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    void this.check();
  }

  list(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t, options: { ...t.options }, schedule: { ...t.schedule } }));
  }

  /** Creates the task, or updates it when `id` is given. Either way the next run is counted from now. */
  async save(id: string | undefined, input: TaskInput): Promise<ScheduledTask> {
    const now = Date.now();
    const existing = id ? this.tasks.find((t) => t.id === id) : undefined;
    const task: ScheduledTask = existing ? Object.assign(existing, input) : { ...input, id: nextId(), createdAt: now, nextRunAt: 0 };
    task.nextRunAt = nextRun(task.schedule, now);
    if (!existing) this.tasks.push(task);
    await this.changed();
    return { ...task };
  }

  /** A paused task picks up at its next time after resuming; runs it missed while paused don't happen. */
  async setPaused(id: string, paused: boolean): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.paused = paused || undefined;
    if (!paused) task.nextRunAt = nextRun(task.schedule, Date.now());
    await this.changed();
  }

  async remove(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.changed();
  }

  /** Starts a run right away, whatever the schedule says; returns its session id. */
  async runNow(id: string): Promise<string | undefined> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return undefined;
    const sessionId = await this.run(task);
    await this.changed();
    return sessionId;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }

  /** Starts every task that's due. One still working from its last run skips this one. */
  private async check(): Promise<void> {
    const now = Date.now();
    const due = this.tasks.filter((t) => !t.paused && t.nextRunAt <= now);
    if (this.checking || !due.length) return;
    this.checking = true;
    try {
      const sessions = await this.api.listSessions();
      for (const task of due) {
        // Counted from now, so several missed runs make one.
        task.nextRunAt = nextRun(task.schedule, now);
        if (sessions.some((s) => s.scheduledTaskId === task.id && isActive(s))) continue;
        await this.run(task).catch((err: unknown) => console.error(`Relay: scheduled task ${task.name} failed to start`, err));
      }
      await this.changed();
    } finally {
      this.checking = false;
    }
  }

  private async run(task: ScheduledTask): Promise<string> {
    task.lastRunAt = Date.now();
    const worktree = task.useWorktree && (await isGitRepo(this.cwd));
    const session = await this.api.createSession(task.options, this.cwd, worktree, task.id);
    if (task.runLimitMs) await this.api.setRunLimit(session.id, task.runLimitMs);
    await this.api.sendMessage(session.id, task.prompt);
    return session.id;
  }

  private async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as TasksFile;
      this.tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
    } catch {
      this.tasks = []; // No file yet, or one that was hand-edited into something unreadable.
    }
  }

  private async changed(): Promise<void> {
    for (const l of this.listeners) l();
    if (!this.file) return;
    const file: TasksFile = { version: 1, tasks: this.tasks };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(file, null, 1));
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}

/** A task as the webview sent it, or undefined when it isn't one. Only the fields a task has get through. */
export function cleanTaskInput(value: unknown): TaskInput | undefined {
  const v = value as Partial<TaskInput> | undefined;
  if (!v || typeof v !== "object" || !v.options || !v.schedule) return undefined;
  const { options, schedule } = v;
  const prompt = typeof v.prompt === "string" ? v.prompt.trim() : "";
  if (!prompt) return undefined;
  if (options.provider !== "claude" && options.provider !== "codex") return undefined;
  if (typeof options.model !== "string" || typeof options.effort !== "string") return undefined;
  if (!REPEATS.includes(schedule.repeat) || typeof schedule.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return undefined;
  const weekday = Number(schedule.weekday);
  const day = Number(schedule.day);
  const limit = Number(v.runLimitMs);
  return {
    name: typeof v.name === "string" ? v.name.trim() : "",
    prompt,
    options: { provider: options.provider, model: options.model, effort: options.effort },
    schedule: {
      repeat: schedule.repeat,
      time: schedule.time,
      weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 1,
      day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1,
    },
    useWorktree: v.useWorktree === true,
    runLimitMs: limit > 0 ? limit : undefined,
  };
}
