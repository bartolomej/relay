import { DEFAULT_RUN_LIMIT_MS, DEFAULT_SCHEDULE, nextRun, ordinal, scheduleLabel, taskName, WEEKDAYS } from "../api/schedule";
import { isActive, minutesLabel, type ModelInfo, type ProviderId, type Repeat, type ScheduledTask, type TaskInput } from "../api/types";
import type { UiState } from "../panel/protocol";
import { pickModel } from "./composer";
import { icons, providerMark } from "./icons";
import { defaultOptions, local } from "./state";
import { ago, elapsed, esc, until } from "./util";

const REPEATS: Array<[Repeat, string]> = [
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];
const LIMITS = [15, 30, 60, 120, 240, 480].map((m) => m * 60000);

function selectedTask(state: UiState): ScheduledTask | undefined {
  return state.tasks.find((t) => t.id === state.selectedTaskId);
}

/** "Mon 29 Sep, 09:00" */
function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "4m ago", "2h ago", "yesterday", "3d ago": `ago` leaves "ago" off longer spans. */
function sinceText(at: number, now: number): string {
  const text = ago(at, now);
  return /ago$|^just now$|^yesterday$/.test(text) ? text : `${text} ago`;
}

/** Switches the list between sessions and scheduled tasks; sits next to the browser button. */
export function scheduledToggle(state: UiState): string {
  if (state.remote) return "";
  const on = state.showScheduled;
  const title = on ? "Back to sessions" : "Scheduled tasks: prompts that start a new session daily, weekly or monthly";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleScheduled" title="${title}" aria-label="Scheduled tasks" aria-pressed="${on}">${icons.calendar}</button>`;
}

// -- the list -----------------------------------------------------------------

function taskCard(state: UiState, t: ScheduledTask): string {
  const running = state.sessions.some((s) => s.scheduledTaskId === t.id && isActive(s));
  const cls = running ? "card-running" : t.paused ? "card-archived" : "card-past";
  const time = running ? "running" : t.paused ? "paused" : `in ${until(t.nextRunAt, state.now)}`;
  const provider = providerMark(t.options.provider);
  return `<div class="card ${cls} ${t.id === state.selectedTaskId ? "selected" : ""} ${running ? "" : "no-icon"}" data-action="selectTask" data-task="${esc(t.id)}" title="${esc(taskName(t))}">
    <div class="card-row">
      ${running ? `<span class="status status-running"></span>` : ""}
      <span class="card-title ellipsis grow">${esc(taskName(t))}</span>
    </div>
    <div class="card-meta">
      ${provider}
      <span class="ellipsis grow">${esc(scheduleLabel(t.schedule))}</span>
      <span class="card-time">${esc(time)}</span>
    </div>
  </div>`;
}

/** Left column while scheduled tasks are shown, in place of the sessions. */
export function renderTasks(state: UiState): string {
  const tasks = state.tasks.slice().sort((a, b) => Number(!!a.paused) - Number(!!b.paused) || a.nextRunAt - b.nextRunAt);
  const list = tasks.length
    ? tasks.map((t) => taskCard(state, t)).join("")
    : `<div class="empty">No scheduled tasks yet. Add one to run a prompt daily, weekly or monthly.</div>`;
  return `<div class="sessions">
    <div class="section-head"><span>Scheduled</span><span class="grow"></span>
      ${scheduledToggle(state)}
      <button class="btn btn-primary" data-action="selectTask" title="New scheduled task">${icons.plus}<span class="btn-text">New</span></button></div>
    <div class="sessions-list task-list">${list}</div>
  </div>`;
}

// -- the form -----------------------------------------------------------------

function blankTask(state: UiState): TaskInput {
  return {
    name: "",
    prompt: "",
    options: defaultOptions(state),
    schedule: { ...DEFAULT_SCHEDULE },
    useWorktree: state.worktrees,
    runLimitMs: DEFAULT_RUN_LIMIT_MS,
  };
}

function copyOf(t: TaskInput): TaskInput {
  return { name: t.name, prompt: t.prompt, options: { ...t.options }, schedule: { ...t.schedule }, useWorktree: t.useWorktree, runLimitMs: t.runLimitMs };
}

/**
 * Loads the form for the selected task, or a blank one, when the selection
 * changed. True when it did, so the fields need drawing again.
 */
export function syncTaskForm(state: UiState): boolean {
  const key = state.selectedTaskId || "new";
  if (local.taskForm && local.taskFormFor === key) return false;
  const task = selectedTask(state);
  local.taskForm = task ? copyOf(task) : blankTask(state);
  local.taskFormFor = key;
  local.taskDirty = false;
  return true;
}

function modelsFor(state: UiState, f: TaskInput): ModelInfo[] {
  const provider = state.providers.find((p) => p.id === f.options.provider);
  const models = provider ? provider.models.slice() : [];
  if (f.options.model && !models.some((m) => m.id === f.options.model)) models.unshift({ id: f.options.model, label: f.options.model, efforts: [] });
  return models;
}

function option(value: string | number, label: string, on: boolean, extra = ""): string {
  return `<option value="${esc(value)}" ${on ? "selected" : ""} ${extra}>${esc(label)}</option>`;
}

/** The editable fields. Drawn only when the task or a choice that changes the fields changes, so typing is never cut off. */
export function renderTaskFields(state: UiState): string {
  const f = local.taskForm;
  if (!f) return "";
  const s = f.schedule;
  const models = modelsFor(state, f);
  const model = models.find((m) => m.id === f.options.model);
  const efforts = model ? model.efforts : [];

  const repeat = `<select class="chip" data-field="repeat" aria-label="Repeat">${REPEATS.map(([v, label]) => option(v, label, s.repeat === v)).join("")}</select>`;
  const weekday =
    s.repeat === "weekly"
      ? `<span class="muted">on</span><select class="chip" data-field="weekday" aria-label="Day of the week">${WEEKDAYS.map((d, i) => option(i, d, s.weekday === i)).join("")}</select>`
      : "";
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const day =
    s.repeat === "monthly"
      ? `<span class="muted">on the</span><select class="chip" data-field="day" aria-label="Day of the month" title="A month without this day runs on its last day">${days.map((d) => option(d, ordinal(d), s.day === d)).join("")}</select>`
      : "";

  const providers = `<span class="chip-wrap has-mark">${providerMark(f.options.provider)}
    <select class="chip" data-field="provider" aria-label="Provider">
      ${state.providers.map((p) => option(p.id, p.unavailable ? `${p.label} (unavailable)` : p.label, p.id === f.options.provider, p.unavailable ? "disabled" : "")).join("")}
    </select></span>`;
  const modelSel = `<select class="chip" data-field="model" aria-label="Model">${models.map((m) => option(m.id, m.label, m.id === f.options.model, `title="${esc(m.description || m.id)}"`)).join("")}</select>`;
  const effortSel = efforts.length ? `<select class="chip" data-field="effort" aria-label="Effort">${efforts.map((e) => option(e, e, e === f.options.effort)).join("")}</select>` : "";

  const limits = LIMITS.map((ms) => option(ms, `Stop after ${minutesLabel(ms)}`, f.runLimitMs === ms)).join("") + option(0, "No time limit", !f.runLimitMs);
  const worktree = state.worktrees
    ? `<label class="check" title="Each run gets its own branch and worktree, so your project folder stays untouched. Complete merges it back."><input type="checkbox" data-field="worktree" ${f.useWorktree ? "checked" : ""}> Work in its own git worktree</label>`
    : `<span class="muted">Runs in the project folder (not a git repository, so no worktree).</span>`;

  return `<label class="field"><span class="field-label">Name</span>
      <input class="field-input" data-field="name" value="${esc(f.name)}" placeholder="${esc(f.prompt ? taskName({ ...f, name: "" }) : "e.g. Weekly dependency check")}"></label>
    <label class="field"><span class="field-label">Prompt</span>
      <textarea class="field-input" data-field="prompt" rows="9" placeholder="What the agent should do each run. It starts fresh every time, with no memory of earlier runs, so include everything it needs to know.">${esc(f.prompt)}</textarea></label>
    <div class="field"><span class="field-label">Repeat</span>
      <div class="field-row">${repeat}${weekday}${day}<span class="muted">at</span><input class="chip" type="time" data-field="time" value="${esc(s.time)}" aria-label="Time"></div></div>
    <div class="field"><span class="field-label">Agent</span>
      <div class="field-row">${providers}${modelSel}${effortSel}</div></div>
    <div class="field"><span class="field-label">Each run</span>
      <div class="field-row">${worktree}<select class="chip" data-field="limit" aria-label="Time limit">${limits}</select></div></div>`;
}

/**
 * Applies an edit from one of the fields. True when the fields depend on it
 * (repeat, provider, model) and need drawing again.
 */
export function updateTaskField(state: UiState, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  const f = local.taskForm;
  if (!f) return false;
  local.taskDirty = true;
  const v = el.value;
  switch (el.dataset.field) {
    case "name":
      f.name = v;
      return false;
    case "prompt":
      f.prompt = v;
      return false;
    case "time":
      if (v) f.schedule.time = v;
      return false;
    case "repeat":
      f.schedule.repeat = v as Repeat;
      return true;
    case "weekday":
      f.schedule.weekday = Number(v);
      return false;
    case "day":
      f.schedule.day = Number(v);
      return false;
    case "provider": {
      const p = state.providers.find((x) => x.id === v);
      f.options.provider = v as ProviderId;
      if (p && p.models.length && !p.models.some((m) => m.id === f.options.model)) pickModel(f.options, p.models[0]);
      return true;
    }
    case "model": {
      const m = modelsFor(state, f).find((x) => x.id === v);
      if (m) pickModel(f.options, m);
      return true;
    }
    case "effort":
      f.options.effort = v;
      return false;
    case "worktree":
      f.useWorktree = (el as HTMLInputElement).checked;
      return false;
    case "limit":
      f.runLimitMs = Number(v) || undefined;
      return false;
  }
  return false;
}

/** The task's head: its name, or that it's new. */
export function renderTaskHead(state: UiState): string {
  const task = selectedTask(state);
  return `<div class="chat-head"><span class="title ellipsis">${esc(task ? taskName(task) : "New scheduled task")}</span></div>`;
}

function runRow(state: UiState, id: string): string {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return "";
  const icon =
    s.status === "running"
      ? `<span class="status status-running"></span>`
      : s.status === "waiting"
        ? `<span class="status status-waiting">${icons.clock}</span>`
        : s.status === "failed"
          ? `<span class="status status-failed">${icons.cross}</span>`
          : `<span class="status status-done">${icons.check}</span>`;
  const time = isActive(s) ? elapsed(s.runStartedAt || s.createdAt, state.now) : ago(s.createdAt, state.now);
  return `<button class="task-run" data-action="select" data-id="${esc(s.id)}" title="Open this run">${icon}<span class="ellipsis grow">${esc(s.title)}</span>${s.unread ? `<span class="unread-dot"></span>` : ""}<span class="muted">${esc(time)}</span></button>`;
}

/** Buttons, when it runs next, and its earlier runs. Drawn on every change; nothing in it is typed into. */
export function renderTaskPanel(state: UiState): string {
  const f = local.taskForm;
  if (!f) return "";
  const task = selectedTask(state);
  const saved = !!task && !local.taskDirty;
  const actions = `<div class="approval-actions">
      <button class="btn btn-primary" data-action="saveTask" ${saved ? "disabled" : ""}>${saved ? "Saved" : "Save"}</button>
      <button class="btn" data-action="saveTask" data-run="1" title="Starts a run now and opens it, to try the prompt out">${saved ? "Run now" : "Save and run now"}</button>
      ${task ? `<button class="btn" data-action="pauseTask" data-task="${esc(task.id)}" data-paused="${task.paused ? "" : "1"}">${task.paused ? "Resume" : "Pause"}</button>` : ""}
      ${task ? `<button class="btn" data-action="deleteTask" data-task="${esc(task.id)}">Delete</button>` : ""}
    </div>`;

  let status: string;
  if (task && task.paused) status = "Paused. It won't run until you resume it.";
  else if (saved && task) status = `Next run ${when(task.nextRunAt)}, in ${until(task.nextRunAt, state.now)}.`;
  else {
    const first = nextRun(f.schedule, state.now);
    status = `${task ? "Once saved, the next" : "The first"} run is ${when(first)}, in ${until(first, state.now)}.`;
  }
  if (task && task.lastRunAt) status += ` Last ran ${sinceText(task.lastRunAt, state.now)}.`;

  const runs = task
    ? state.sessions
        .filter((s) => s.scheduledTaskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map((s) => runRow(state, s.id))
        .join("")
    : "";

  return `${actions}
    <div class="task-status">${esc(status)}</div>
    <div class="task-note">Runs only while this project is open in VS Code. A run missed while VS Code was closed or the Mac slept starts once when it's back, and a run is skipped while the previous one is still working. Each run is a new session tagged Scheduled.</div>
    ${runs ? `<div class="group-head"><span>Runs</span></div><div class="task-runs">${runs}</div>` : ""}`;
}
