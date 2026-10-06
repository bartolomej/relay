import { hasBackground, isActive, type BackgroundTask, type Session } from "../api/types";
import type { UiState } from "../panel/protocol";
import { icons, providerMark } from "./icons";
import { local } from "./state";
import { settingsToggle } from "./settings";
import { scheduledToggle } from "./tasks";
import { ago, elapsed, esc } from "./util";

interface Node {
  session: Session;
  children: Node[];
}

/** Where a session and its forks are listed. A tree moves as one unit, placed by its most active member. */
type Group = "working" | "review" | "past" | "archived";

function buildTree(sessions: Session[]): Node[] {
  const byId = new Map<string, Node>();
  for (const s of sessions) byId.set(s.id, { session: s, children: [] });
  const roots: Node[] = [];
  for (const node of byId.values()) {
    const parent = node.session.parentId ? byId.get(node.session.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (n: Node) => {
    n.children.sort((a, b) => a.session.createdAt - b.session.createdAt);
    n.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  return roots;
}

function members(n: Node): Session[] {
  return [n.session, ...n.children.flatMap(members)];
}

/** Last time the session ran or the user checked it, so a just-reviewed session tops Past. */
function latestActivity(n: Node): number {
  return Math.max(...members(n).map((s) => Math.max(s.lastActivityAt, s.seenAt || 0)));
}

/** Busy, or idle while the agent's background work runs. */
function working(s: Session): boolean {
  return isActive(s) || hasBackground(s);
}

/** When the tree started its current run, so working cards keep their order while they work. */
function runStart(n: Node): number {
  return Math.min(...members(n).filter(working).map((s) => s.runStartedAt || s.createdAt));
}

function groupOf(n: Node): Group {
  const all = members(n);
  if (all.some(working)) return "working";
  const live = all.filter((s) => !s.archived);
  if (live.length === 0) return "archived";
  return live.some((s) => s.unread) ? "review" : "past";
}

/** A fork whose whole subtree was completed stays hidden unless all past sessions are shown. */
function completed(n: Node): boolean {
  return members(n).every((s) => s.archived);
}

function statusIcon(s: Session): string {
  switch (s.status) {
    case "running":
      return `<span class="status status-running"></span>`;
    case "waiting":
      return `<span class="status status-waiting">${icons.clock}</span>`;
    case "done":
      // Finished is the normal state; a check says nothing, so show none.
      return "";
    case "failed":
      return `<span class="status status-failed">${icons.cross}</span>`;
  }
}

function cardClass(s: Session): string {
  if (s.status === "running") return "card-running";
  if (s.status === "waiting") return "card-waiting";
  if (s.archived) return "card-archived";
  if (s.unread) return s.status === "failed" ? "card-failed" : "card-done";
  return "card-past";
}

function modelLabel(state: UiState, s: Session): string {
  const p = state.providers.find((x) => x.id === s.options.provider);
  const m = p && p.models.find((x) => x.id === s.options.model);
  return m ? m.label : s.options.model;
}

function providerLabel(state: UiState, s: Session): string {
  const p = state.providers.find((x) => x.id === s.options.provider);
  return p ? p.label : s.options.provider;
}

function providerIcon(state: UiState, s: Session): string {
  return providerMark(s.options.provider, providerLabel(state, s));
}

function timeCell(s: Session, now: number): string {
  if (s.status === "running") return elapsed(s.runStartedAt || s.createdAt, now);
  if (s.status === "waiting") return s.pendingQuestions ? "Has a question" : "Needs approval";
  return ago(s.lastActivityAt, now);
}

/** The work an agent left running between turns, listed on hover. */
export function backgroundTag(s: Session, cls = ""): string {
  if (!s.background || !s.background.length) return "";
  const n = s.background.length;
  const list = s.background.map((t) => `• ${t.description}${t.command ? `: ${t.command}` : ""}`).join("\n");
  const title = `Running in the background; the agent picks up again as it finishes:\n${list}`;
  return `<span class="mode-tag ${cls}" title="${esc(title)}">Background${n > 1 ? ` · ${n}` : ""}</span>`;
}

/** Hangs off its session like a fork, but dashed: it's work, not a chat. */
function backgroundRow(t: BackgroundTask, now: number): string {
  const title = `Running in the background; the agent picks up again when it finishes.\n${t.description}${t.command ? `\n${t.command}` : ""}`;
  return `<div class="child"><div class="branch"></div>
    <div class="bg-task" title="${esc(title)}">
      <div class="bg-task-row">
        ${t.command ? icons.terminal : icons.spawn}
        <span class="ellipsis grow">${esc(t.description || t.command || "Background task")}</span>
        <span class="bg-task-time">${esc(elapsed(t.startedAt, now))}</span>
      </div>
      ${t.command && t.command !== t.description ? `<div class="bg-task-cmd mono ellipsis">${esc(t.command)}</div>` : ""}
    </div>
  </div>`;
}

function card(state: UiState, node: Node, depth: number): string {
  const s = node.session;
  const isSel = s.id === state.selectedSessionId;
  const forkNote = s.forkedFromIndex ? `from msg ${s.forkedFromIndex} · ` : "";
  const approvalNote =
    depth === 0 && s.pendingApproval
      ? `<span class="mono">${esc(`${s.pendingApproval.kind}: ${s.pendingApproval.detail.split(" ").slice(0, 2).join(" ")}`)}</span>`
      : depth === 0 && s.pendingQuestions
        ? `<span>${esc(s.pendingQuestions.map((q) => q.header || q.question).join(", "))}</span>`
        : "";
  const canStop = isActive(s);
  const canComplete = !isActive(s) && !s.archived;
  const approval =
    s.pendingApproval && (isSel || depth === 0)
      ? `<div class="card-actions">
           <button class="btn btn-primary" data-action="approve" data-id="${esc(s.id)}" data-decision="allow">Allow</button>
           <button class="btn" data-action="approve" data-id="${esc(s.id)}" data-decision="deny">Deny</button>
           <button class="btn" data-action="approve" data-id="${esc(s.id)}" data-decision="always">Always for this session</button>
         </div>`
      : "";
  const visibleChildren = node.children.filter((c) => state.showAllPast || !completed(c));
  const background = s.background || [];
  const children = visibleChildren.length || background.length
    ? `<div class="children">
         ${background.map((t) => backgroundRow(t, state.now)).join("")}
         ${visibleChildren.map((c) => `<div class="child"><div class="branch"></div>${card(state, c, depth + 1)}</div>`).join("")}
         ${isSel && visibleChildren.length ? `<div class="child"><div class="branch"></div><button class="fork-slot" data-action="fork" data-id="${esc(s.id)}">${icons.plus} Fork from latest message</button></div>` : ""}
       </div>`
    : "";
  const icon = statusIcon(s);
  return `<div class="card ${cardClass(s)} ${s.unread ? "unread" : ""} ${isSel ? "selected" : ""} ${icon ? "" : "no-icon"}" data-action="select" data-id="${esc(s.id)}" title="${esc(s.title)}">
    <div class="card-row">
      ${icon}
      <span class="card-title ellipsis grow">${esc(s.title)}</span>
      ${s.unread ? `<span class="unread-dot" title="Finished, not opened yet"></span>` : ""}
    </div>
    <div class="card-meta">
      ${providerIcon(state, s)}
      ${s.scheduledTaskId ? `<span class="mode-tag card-tag">Scheduled</span>` : ""}
      <span class="ellipsis grow">${esc(forkNote)}${esc(modelLabel(state, s))} · ${esc(s.options.effort)}</span>
      ${approvalNote}
      <span class="card-tools">
        <button class="icon-btn sm" data-action="fork" data-id="${esc(s.id)}" title="Fork session" aria-label="Fork session">${icons.fork}</button>
        ${canStop ? `<button class="icon-btn sm" data-action="stop" data-id="${esc(s.id)}" title="Stop" aria-label="Stop">${icons.stop}</button>` : ""}
        ${!canStop && hasBackground(s) ? `<button class="icon-btn sm" data-action="stop" data-id="${esc(s.id)}" title="Stop the background work" aria-label="Stop the background work">${icons.stop}</button>` : ""}
        ${canComplete ? `<button class="icon-btn sm" data-action="complete" data-id="${esc(s.id)}" title="Complete" aria-label="Complete session">${icons.check}</button>` : ""}
      </span>
      <span class="card-time" ${isActive(s) ? "" : `title="${esc(`Started: ${ago(s.createdAt, state.now)} · Last active: ${ago(s.lastActivityAt, state.now)}`)}"`}>${esc(s.archived ? "completed" : timeCell(s, state.now))}</span>
    </div>
    ${approval}
    ${children}
  </div>`;
}

function group(state: UiState, title: string, note: string, nodes: Node[], tools = ""): string {
  return `<div class="group-head"><span>${esc(title)}</span><span class="count">${esc(note)}</span>${tools}</div>
    ${nodes.map((n) => card(state, n, 0)).join("")}`;
}

/** With all past sessions shown, Past's heading collapses them again and searches their titles. */
function pastTools(): string {
  return `<button class="icon-btn sm past-collapse" data-action="toggleAllPast" title="Hide older and completed" aria-label="Hide older and completed">${icons.chevron}</button>
    <input class="past-search" type="search" placeholder="Search titles" aria-label="Search past session titles" value="${esc(local.pastQuery)}">`;
}

function matches(n: Node, query: string): boolean {
  return members(n).some((s) => s.title.toLowerCase().includes(query));
}

/** Serves Relay to the phone through Tailscale; clicking again turns it off. */
function remoteToggle(state: UiState): string {
  const on = state.remoteAccess;
  const title = on ? "Remote access is on. Click to turn it off." : "Turn on remote access from your phone";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleRemote" title="${title}" aria-label="Remote access" aria-pressed="${on}">${icons.phone}</button>`;
}

/** On: Jev suggests a model for each message, next to the model dropdown. */
function modelHintsToggle(state: UiState): string {
  if (state.modelHints === undefined) return "";
  const on = state.modelHints;
  const title = on
    ? "Jev suggests a model for each message from how hard it looks; ⇧⌘↵ sends with the suggestion. Click to turn off."
    : "Let Jev suggest a model for each message: a quick one for simple changes, the strongest for open-ended work. Asks for your TypeSafe API key the first time; what you type is sent to TypeSafe.";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleModelHints" title="${esc(title)}" aria-label="Model suggestions from Jev" aria-pressed="${on}">${icons.gauge}</button>`;
}

export function renderSessions(state: UiState): string {
  const cutoff = state.now - state.pastWindowMs;
  const working: Node[] = [];
  const review: Node[] = [];
  const recent: Node[] = [];
  const older: Node[] = [];
  for (const root of buildTree(state.sessions)) {
    const g = groupOf(root);
    if (g === "working") working.push(root);
    else if (g === "review") review.push(root);
    else if (g === "past" && latestActivity(root) >= cutoff) recent.push(root);
    else older.push(root);
  }
  const byLatest = (a: Node, b: Node) => latestActivity(b) - latestActivity(a);
  working.sort((a, b) => runStart(b) - runStart(a));
  review.sort(byLatest);
  const expanded = state.showAllPast && older.length > 0;
  const query = expanded ? local.pastQuery.trim().toLowerCase() : "";
  const past = (state.showAllPast ? recent.concat(older) : recent).filter((n) => !query || matches(n, query)).sort(byLatest);

  const hours = Math.round(state.pastWindowMs / 3_600_000);
  const toggle =
    older.length && !state.showAllPast
      ? `<button class="older-toggle" data-action="toggleAllPast">${icons.chevron}
           Show all past sessions <span class="muted">· ${older.length} more</span></button>`
      : "";
  const nothing = !working.length && !review.length && !past.length && !query;

  const head =
    state.layout === "wide"
      ? `<div class="section-head"><span>Sessions</span><span class="grow"></span>
           <button class="icon-btn" data-action="openBrowser" title="Open your app in Relay's browser to add notes on elements" aria-label="Open in Browser">${icons.globe}</button>
           ${scheduledToggle(state)}
           ${remoteToggle(state)}
           ${modelHintsToggle(state)}
           ${settingsToggle(state)}
           <button class="btn btn-primary" data-action="newSession" title="New session">${icons.plus}<span class="btn-text">New</span></button></div>`
      : "";

  return `<div class="sessions">
    ${head}
    <div class="sessions-list">
      ${working.length ? group(state, "Working", String(working.length), working) : ""}
      ${review.length ? group(state, "Ready to review", String(review.length), review) : ""}
      ${past.length || expanded ? group(state, "Past", state.showAllPast ? "all" : `last ${hours}h`, past, expanded ? pastTools() : "") : ""}
      ${expanded && !past.length ? `<div class="empty">No past sessions match.</div>` : ""}
      ${nothing ? `<div class="empty">No recent sessions. Type below to start one.</div>` : ""}
      ${toggle}
    </div>
  </div>`;
}
