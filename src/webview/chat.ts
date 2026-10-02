import { hasBackground, isActive, minutesLabel, type Answers, type Message, type MessageMode, type Question, type Session, type ToolEvent } from "../api/types";
import { taskName } from "../api/schedule";
import type { UiState } from "../panel/protocol";
import { icons, providerMark } from "./icons";
import { elapsed, esc, level, tokens } from "./util";
import { local, newBrowser, newWorktree, selected } from "./state";
import { renderMarkdown } from "./markdown";
import { renderInspect } from "./inspect";
import { backgroundTag } from "./sessions";

function toolIcon(kind: ToolEvent["kind"]): string {
  switch (kind) {
    case "read":
      return icons.eye;
    case "edit":
    case "write":
      return icons.pencil;
    case "other":
      return icons.spawn;
    case "run":
      return icons.terminal;
  }
}

/** On the phone there's no editor to open a file in, so paths are plain text. */
function tool(t: ToolEvent, openable: boolean): string {
  const diff =
    t.added !== undefined || t.removed !== undefined
      ? `<span class="right"><span class="add">+${t.added || 0}</span> <span class="del">−${t.removed || 0}</span></span>`
      : t.detail
        ? `<span class="right ${t.ok ? "add" : ""}">${esc(t.detail)}</span>`
        : "";
  const target = t.path && openable
    ? `<a class="target mono ellipsis file-link" data-action="openFile" data-path="${esc(t.path)}" title="Open ${esc(t.target)}">${esc(t.target)}</a>`
    : `<span class="target mono ellipsis">${esc(t.target)}</span>`;
  return `<div class="tool">${toolIcon(t.kind)}<span class="label ellipsis">${esc(t.label)}</span>${target}${diff}</div>`;
}

/** The latest user message is pinned so the reply below it keeps its question in view while scrolling. */
function message(m: Message, session: Session, pinned: boolean, answer: boolean, links: Set<string>, openable: boolean): string {
  if (m.role === "user") {
    const cls = pinned ? `msg-pinned ${local.expandedPin === m.id ? "expanded" : ""}` : "";
    const toggle = pinned ? ` data-action="togglePin" data-mid="${esc(m.id)}"` : "";
    return `<div class="msg msg-user ${cls}" data-mid="${esc(m.id)}"><div class="bubble"${toggle}>${modeTag(m.mode)}${esc(m.text)}</div></div>`;
  }
  const tools = m.tools && m.tools.length ? `<div class="tools">${m.tools.map((t) => tool(t, openable)).join("")}</div>` : "";
  const caret = m.streaming ? `<span class="caret"></span>` : "";
  // Before any text, the loader below the messages shows it's working.
  const label = answer ? `<div class="msg-answer" title="Answer">${icons.answer}</div>` : "";
  const text = m.text ? `${label}<div class="msg-text md">${renderMarkdown(m.text, links)}${caret}</div>` : "";
  const toolbar = m.streaming
    ? ""
    : `<div class="msg-tools">
         <button class="icon-btn" data-action="forkAt" data-id="${esc(session.id)}" data-mid="${esc(m.id)}" title="Fork from here" aria-label="Fork from this message">${icons.fork}</button>
         <button class="icon-btn" data-action="copy" data-mid="${esc(m.id)}" title="Copy" aria-label="Copy message">${icons.copy}</button>
       </div>`;
  return `<div class="msg msg-assistant" data-mid="${esc(m.id)}">${toolbar}${tools}${text}</div>`;
}

/** The closing reply of each finished turn that ran tools, so its answer stands apart from the work. */
function answers(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  let worked = false;
  messages.forEach((m, i) => {
    if (m.role === "user") {
      worked = false;
      return;
    }
    if (m.tools && m.tools.length) worked = true;
    const next = messages[i + 1];
    if (worked && m.text && !m.streaming && (!next || next.role === "user")) ids.add(m.id);
  });
  return ids;
}

function modeTag(mode: MessageMode | undefined): string {
  if (mode === "plan") return `<span class="mode-tag" title="Sent in plan mode: the agent was asked to ask questions before writing code">Plan</span>`;
  if (mode === "ask") return `<span class="mode-tag" title="Sent in ask mode: the agent was asked to just answer, with read-only access">Ask</span>`;
  return "";
}

/** Each line coloured by its mark; a line without one names the file below it. */
function diffBlock(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const cls = /^(\+\+\+|---) /.test(line) ? "d-file" : line[0] === "+" ? "d-add" : line[0] === "-" ? "d-del" : line[0] === "@" ? "d-hunk" : line[0] === " " || line[0] === "…" ? "" : "d-file";
    return `<span class="${cls}">${esc(line) || " "}</span>`;
  });
  return `<pre class="approval-diff mono">${lines.join("")}</pre>`;
}

function approval(s: Session): string {
  if (!s.pendingApproval) return "";
  return `<div class="approval">
    <div class="approval-title">${icons.clock}<span>${esc(s.pendingApproval.summary)}</span></div>
    <div class="approval-cmd mono">${esc(s.pendingApproval.detail)}</div>
    ${s.pendingApproval.diff ? diffBlock(s.pendingApproval.diff) : ""}
    <div class="approval-actions">
      <button class="btn btn-primary" data-action="approve" data-id="${esc(s.id)}" data-decision="allow">Allow</button>
      <button class="btn" data-action="approve" data-id="${esc(s.id)}" data-decision="deny">Deny</button>
      <button class="btn" data-action="approve" data-id="${esc(s.id)}" data-decision="always">Always allow ${esc(s.pendingApproval.detail.split(" ").slice(0, 2).join(" "))}</button>
    </div>
  </div>`;
}

/** A typed answer replaces the pick of a one-pick question and adds to a pick-any one. */
function answerTo(q: Question, sessionId: string): string[] {
  const picked = (local.picks[sessionId] || {})[q.id] || [];
  const typed = ((local.typed[sessionId] || {})[q.id] || "").trim();
  if (!typed) return picked;
  return q.multiSelect ? picked.concat(typed) : [typed];
}

/** Everything answered so far; undefined until every question has an answer. */
export function answersFor(s: Session): Answers | undefined {
  const qs = s.pendingQuestions || [];
  const answers: Answers = {};
  for (const q of qs) {
    const a = answerTo(q, s.id);
    if (!a.length) return undefined;
    answers[q.id] = a;
  }
  return answers;
}

/**
 * The agent's multiple-choice questions. Typed answers aren't part of the
 * HTML, so typing doesn't redraw the chat; main.ts puts them back after a redraw.
 */
function questions(s: Session): string {
  const qs = s.pendingQuestions;
  if (!qs || !qs.length) return "";
  const picks = local.picks[s.id] || {};
  const body = qs
    .map((q) => {
      const picked = picks[q.id] || [];
      const options = q.options
        .map((o) => {
          const on = picked.includes(o.label);
          const desc = o.description ? `<span class="option-desc">${esc(o.description)}</span>` : "";
          return `<button class="option ${on ? "picked" : ""}" data-action="pickOption" data-id="${esc(s.id)}" data-qid="${esc(q.id)}" data-label="${esc(o.label)}" aria-pressed="${on}"><span class="option-label">${esc(o.label)}</span>${desc}</button>`;
        })
        .join("");
      const tag = q.header ? `<span class="mode-tag">${esc(q.header)}</span>` : "";
      const any = q.multiSelect ? `<span class="muted"> · pick any</span>` : "";
      const hint = q.options.length ? "Or type your own answer…" : "Type your answer…";
      return `<div class="question">
        <div class="question-text">${tag}${esc(q.question)}${any}</div>
        ${options ? `<div class="question-options">${options}</div>` : ""}
        <input class="question-other" type="${q.secret ? "password" : "text"}" data-id="${esc(s.id)}" data-qid="${esc(q.id)}" placeholder="${hint}" aria-label="${esc(hint)}">
      </div>`;
    })
    .join("");
  return `<div class="approval">
    <div class="approval-title">${icons.clock}<span>${qs.length > 1 ? "has a few questions" : "has a question"}</span></div>
    ${body}
    <div class="approval-actions">
      <button class="btn btn-primary" data-action="answer" data-id="${esc(s.id)}" ${answersFor(s) ? "" : "disabled"}>Send ${qs.length > 1 ? "answers" : "answer"}</button>
      <button class="btn" data-action="skipQuestions" data-id="${esc(s.id)}" title="The agent asks in a message instead, and you reply in the message box">Answer in a message</button>
    </div>
  </div>`;
}

/** Context fill, then the tokens read (up) and written (down) so far; each part only once it's known. */
function tokenMeter(s: Session): string {
  const parts: string[] = [];
  const title: string[] = [];
  if (s.context) {
    const { usedTokens: used, limitTokens: limit } = s.context;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    title.push(`Context: ${used.toLocaleString()} of ${limit.toLocaleString()} tokens (${pct}%)`);
    parts.push(`<span class="ctx-part ctx-${level(pct)}">${icons.context}${esc(`${tokens(used)} / ${tokens(limit)}`)}</span>`);
  }
  if (s.tokens) {
    const t = s.tokens;
    title.push(`In: ${t.input.toLocaleString()} tokens, ${t.cachedInput.toLocaleString()} of them from cache`, `Out: ${t.output.toLocaleString()} tokens`);
    parts.push(`<span class="ctx-part">${icons.arrowUp}${esc(tokens(t.input))}</span><span class="ctx-part">${icons.arrowDown}${esc(tokens(t.output))}</span>`);
  }
  if (!parts.length) return "";
  return `<span class="ctx" title="${esc(title.join("\n"))}">${parts.join("")}</span>`;
}

/** On: the computer stays awake while any agent works. Off: it may sleep. */
function keepAwakeToggle(state: UiState): string {
  if (state.keepAwake === undefined) return "";
  if (state.remoteAccess) {
    const title = "Remote access is on, so the computer stays awake until all agents are done.";
    return `<button class="icon-btn on" disabled title="${title}" aria-label="${title}" aria-pressed="true">${icons.coffee}</button>`;
  }
  const on = state.keepAwake;
  const title = on ? "Keeping the computer awake while agents work. Click to let it sleep." : "The computer may sleep while agents work. Click to keep it awake.";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleKeepAwake" title="${title}" aria-label="Keep awake while working" aria-pressed="${on}">${on ? icons.coffee : icons.moon}</button>`;
}

/**
 * On: the agent works in a git worktree of its own, merged back on Complete.
 * Only a new session can switch it; afterwards it shows where the session works.
 */
function worktreeToggle(state: UiState, s: Session | undefined): string {
  if (!state.worktrees && !(s && s.worktree)) return "";
  if (!s) {
    const on = newWorktree(state);
    const title = on
      ? "This session will work in its own git worktree and merge back on Complete. Click to work in the project folder."
      : "This session will work in the project folder. Click to give it its own git worktree, merged back on Complete.";
    return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleWorktree" title="${title}" aria-label="Work in a git worktree" aria-pressed="${on}">${icons.worktree}</button>`;
  }
  const wt = s.worktree;
  const on = !!(wt || s.useWorktree);
  const title = wt
    ? `Working in a worktree on ${wt.branch}. Complete merges it into ${wt.base}.`
    : on
      ? "Works in a git worktree, created with the first message."
      : "Works in the project folder. Only a new session can use a worktree.";
  return `<button class="icon-btn ${on ? "on" : ""}" disabled title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${on}">${icons.worktree}</button>`;
}

/** How long the current run has worked, against its limit; clicking sets the limit. */
function runClock(state: UiState, s: Session): string {
  const running = isActive(s) && s.runStartedAt !== undefined;
  const limit = s.runLimitMs ? minutesLabel(s.runLimitMs) : "";
  const near = running && s.runLimitMs && s.runStartedAt && state.now - s.runStartedAt >= s.runLimitMs * 0.9;
  const clock = running ? `<span data-since="${s.runStartedAt}">${esc(elapsed(s.runStartedAt || 0, state.now))}</span>` : "";
  const text = clock && limit ? `${clock}<span class="muted">/ ${esc(limit)}</span>` : clock || esc(limit);
  const title = limit ? `Time limit: ${limit} per run. Click to change.` : "No time limit. Click to set one.";
  return `<button class="run-clock ${near ? "near" : ""}" data-action="setRunLimit" data-id="${esc(s.id)}" title="${esc(title)}" aria-label="${esc(title)}">${icons.timer}${text}</button>`;
}

/** Asks the other provider to review this session's work, in a subsession with the message drafted. */
function secondOpinion(state: UiState, s: Session): string {
  if (isActive(s) || !state.messages.some((m) => m.role === "assistant")) return "";
  const other = state.providers.find((p) => p.id !== s.options.provider && !p.unavailable && p.models.length);
  if (!other) return "";
  const title = `Second opinion from ${other.label}: opens a subsession with a review request drafted for you to send`;
  return `<button class="icon-btn" data-action="secondOpinion" data-id="${esc(s.id)}" title="${esc(title)}" aria-label="${esc(`Second opinion from ${other.label}`)}">${icons.opinion}</button>`;
}

/** A run of a scheduled task links back to the task. */
function scheduledTag(state: UiState, s: Session): string {
  if (state.remote || !s.scheduledTaskId) return "";
  const task = state.tasks.find((t) => t.id === s.scheduledTaskId);
  const title = task ? `Started by the scheduled task “${taskName(task)}”. Click to open it.` : "Started by a scheduled task that has since been deleted.";
  return `<button class="mode-tag task-tag" data-action="selectTask" data-task="${esc(task ? task.id : "")}" title="${esc(title)}" ${task ? "" : "disabled"}>Scheduled</button>`;
}

/** Swaps the chat for the inspector. Only Claude reports what it loaded and how a turn went. */
function inspectToggle(state: UiState, s: Session): string {
  if (s.options.provider !== "claude" && !state.inspecting) return "";
  const on = state.inspecting;
  const title = on ? "Back to the chat" : "Inspect: files in context, CLAUDE.md and other memory files, every tool call, timings and events";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleInspect" title="${esc(title)}" aria-label="Inspect this session" aria-pressed="${on}">${icons.bug}</button>`;
}

/** On: the agent can drive Relay's browser, opened for it when a turn starts. */
function browserToggle(state: UiState, s: Session | undefined): string {
  const on = s ? !!s.browserAccess : newBrowser(state);
  const title = on
    ? "The agent can drive Relay's browser: open pages, click, type, read the console and take screenshots. Click to turn it off."
    : "Let the agent drive Relay's browser, the window with your logins. It opens when the agent starts working; if it's already open without agent access, it restarts once and reopens its tabs.";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleBrowserAccess" data-id="${s ? esc(s.id) : ""}" title="${esc(title)}" aria-label="Let the agent use Relay's browser" aria-pressed="${on}">${icons.browserAgent}</button>`;
}

function head(state: UiState, s: Session | undefined): string {
  if (!s) {
    return `<div class="chat-head"><span class="title grow">New session</span>${worktreeToggle(state, undefined)}${browserToggle(state, undefined)}${keepAwakeToggle(state)}</div>`;
  }
  const status =
    s.status === "running"
      ? `<span class="status status-running"></span>`
      : s.status === "waiting"
        ? `<span class="status status-waiting">${icons.clock}</span>`
        : s.status === "failed"
          ? `<span class="status status-failed">${icons.cross}</span>`
          : `<span class="status status-done">${icons.check}</span>`;
  const p = state.providers.find((x) => x.id === s.options.provider);
  const m = p && p.models.find((x) => x.id === s.options.model);
  // The model shows as its provider's icon; hovering it names the model.
  const model = `${p ? p.label : s.options.provider} · ${m ? m.label : s.options.model}`;
  const sub =
    state.layout === "wide"
      ? `${providerMark(s.options.provider, model)}<span class="muted ellipsis">${esc(s.options.effort)} · ${esc(s.folder)}</span>`
      : "";
  const ctx = tokenMeter(s);
  const complete = isActive(s)
    ? ""
    : s.archived
      ? `<span class="muted">Completed</span>`
      : `<button class="btn btn-complete" data-action="complete" data-id="${esc(s.id)}" title="${s.worktree ? esc(`Merge ${s.worktree.branch} into ${s.worktree.base}, then mark complete`) : "Mark complete and hide from the list"}">${icons.check} Complete</button>`;
  return `<div class="chat-head">
    ${status}
    <span class="title ellipsis">${esc(s.title)}</span>${sub}<span class="grow"></span>
    ${backgroundTag(s, "head-tag")}
    ${ctx}
    ${runClock(state, s)}
    ${inspectToggle(state, s)}
    ${worktreeToggle(state, s)}
    ${browserToggle(state, s)}
    ${keepAwakeToggle(state)}
    ${secondOpinion(state, s)}
    ${scheduledTag(state, s)}
    <button class="icon-btn" data-action="fork" data-id="${esc(s.id)}" title="Fork session" aria-label="Fork session">${icons.fork}</button>
    ${isActive(s) ? `<button class="icon-btn" data-action="stop" data-id="${esc(s.id)}" title="Stop" aria-label="Stop session">${icons.stop}</button>` : ""}
    ${!isActive(s) && hasBackground(s) ? `<button class="icon-btn" data-action="stop" data-id="${esc(s.id)}" title="Stop the background work" aria-label="Stop the background work">${icons.stop}</button>` : ""}
    ${complete}
  </div>`;
}

/** While the turn has no text streaming: the model thinking, or a tool it called still running. */
function loader(s: Session, messages: Message[]): string {
  if (s.status !== "running") return "";
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && last.text) return "";
  // Codex never marks some tools done, so only the latest call counts.
  const tools = last && last.role === "assistant" && last.tools ? last.tools : [];
  const tool = tools.length > 0 && tools[tools.length - 1].ok === undefined;
  return `<div class="thinking"><span class="status status-running"></span>${tool ? "Running…" : "Thinking…"}</div>`;
}

/** Messages waiting for the running turn to end, just above the composer. */
function queued(s: Session): string {
  if (!s.queued.length) return "";
  const note = isActive(s) ? "sends when the current turn ends" : "session stopped";
  return `<div class="queued">
    <div class="queued-head">Queued · ${s.queued.length}<span class="muted">· ${esc(note)}</span></div>
    ${s.queued
      .map(
        (q) => `<div class="queued-item">
          <span class="ellipsis grow" title="${esc(q.text)}">${modeTag(q.mode)}${esc(q.text)}</span>
          <button class="icon-btn sm" data-action="sendQueuedNow" data-id="${esc(s.id)}" data-qid="${esc(q.id)}" title="Send now (interrupts)" aria-label="Send now">${icons.send}</button>
          <button class="icon-btn sm" data-action="removeQueued" data-id="${esc(s.id)}" data-qid="${esc(q.id)}" title="Remove" aria-label="Remove from queue">${icons.cross}</button>
        </div>`,
      )
      .join("")}
  </div>`;
}

export function renderChat(state: UiState): string {
  const s = selected(state);
  const lastUser = state.messages.map((m) => m.role).lastIndexOf("user");
  const links = new Set(state.linkable);
  const answered = answers(state.messages);
  if (s && state.inspecting) return `<div class="chat">${head(state, s)}${renderInspect(state, s)}</div>`;
  const body = !s
    ? `<div class="empty">Pick a session above, or type below to start a new one.</div>`
    : state.messages.length === 0
      ? `<div class="empty">Empty session. Say what you want done.</div>`
      : `<div class="messages-inner">${state.messages.map((m, i) => message(m, s, i === lastUser, answered.has(m.id), links, !state.remote)).join("")}${loader(s, state.messages)}${approval(s)}${questions(s)}</div>`;
  return `<div class="chat">${head(state, s)}<div class="messages" id="messages">${body}</div>${s ? queued(s) : ""}</div>`;
}
