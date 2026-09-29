import { durationLabel, type InspectContext, type InspectEvent, type InspectTool, type Session, type SessionInspect } from "../api/types";
import type { UiState } from "../panel/protocol";
import { icons } from "./icons";
import { esc, tokens } from "./util";

/** Context categories get the chart colours in this order; past the last one they fold into "Other". */
const SERIES = 7;
/** Tool calls listed at most, newest kept; the counts above the list still cover them all. */
const MAX_ROWS = 400;

/**
 * The session inspector, in place of the chat: how Claude Code was set up,
 * what fills the context window, the files it touched, every tool call
 * (subagents' included) and notable events such as compactions and retries.
 */
export function renderInspect(state: UiState, s: Session): string {
  const i = state.inspect;
  const tools = i && i.tools.length ? i.tools : fromMessages(state);
  const banner = `<div class="insp-banner">${icons.bug}<span class="insp-banner-title">Inspector</span>
    <span class="muted ellipsis grow">How this session was set up and how it ran</span>
    <button class="btn" data-action="toggleInspect">Back to chat</button></div>`;
  const note =
    !i || !i.setup
      ? `<div class="insp-note">Setup, context breakdown and events arrive with this session's next turn. Until then this shows what the chat already recorded.</div>`
      : "";
  return `<div class="inspect" id="inspect"><div class="inspect-inner">${banner}${note}
    ${overview(state, s, i)}
    ${context(i && i.context, s, !state.remote)}
    ${files(tools, !state.remote)}
    ${toolCalls(tools, !state.remote)}
    ${events(i ? i.events : [])}
  </div></div>`;
}

/** Sessions from before the inspector only have the chat's tool rows, without times or subagents. */
function fromMessages(state: UiState): InspectTool[] {
  const out: InspectTool[] = [];
  for (const m of state.messages) {
    for (const t of m.tools || []) {
      out.push({ id: t.id, name: t.label, kind: t.kind, label: t.label, target: t.target, path: t.path, startedAt: m.createdAt, ok: t.ok });
    }
  }
  return out;
}

function section(title: string, summary: string, body: string): string {
  return `<section class="insp-sec"><div class="group-head">${esc(title)}<span class="count">${summary}</span></div>${body}</section>`;
}

function kv(rows: Array<[string, string]>): string {
  return `<div class="insp-kv">${rows.map(([k, v]) => `<span class="muted">${esc(k)}</span><span>${v}</span>`).join("")}</div>`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fileLink(path: string, shown: string, openable: boolean): string {
  return openable
    ? `<a class="mono ellipsis file-link" data-action="openFile" data-path="${esc(path)}" title="Open ${esc(path)}">${esc(shown)}</a>`
    : `<span class="mono ellipsis" title="${esc(path)}">${esc(shown)}</span>`;
}

function list(items: string[]): string {
  return items.length ? items.map(esc).join(", ") : `<span class="muted">none</span>`;
}

// -- overview ---------------------------------------------------------------

function overview(state: UiState, s: Session, i: SessionInspect | undefined): string {
  const setup = i && i.setup;
  const stats = i && i.stats;
  const rows: Array<[string, string]> = [["Model", esc(setup ? setup.model : s.options.model)]];
  if (setup) {
    rows.push(["Claude Code", esc(setup.version)], ["Permissions", esc(setup.permissionMode)], ["Output style", esc(setup.outputStyle)]);
  }
  rows.push(["Effort", esc(s.options.effort)]);
  if (stats) {
    rows.push(
      ["Turns", `${stats.turns} ${stats.turns === 1 ? "turn" : "turns"} <span class="muted">· ${stats.roundTrips} model requests</span>`],
      [
        "Time",
        `${esc(durationLabel(stats.durationMs))} <span class="muted" title="Time spent in requests to the model; more than the total when subagents run at the same time">· model ${esc(durationLabel(stats.apiDurationMs))}</span>`,
      ],
      ["Cost", `$${stats.costUsd.toFixed(2)} <span class="muted">· at API prices, as Claude Code estimates it</span>`],
    );
    for (const m of stats.models) {
      const read = m.input + m.cacheRead + m.cacheWrite;
      const hit = read ? Math.round((m.cacheRead / read) * 100) : 0;
      const title = `${m.input.toLocaleString()} uncached in, ${m.cacheRead.toLocaleString()} read from cache, ${m.cacheWrite.toLocaleString()} written to cache, ${m.output.toLocaleString()} out`;
      rows.push([
        m.model,
        `<span title="${esc(title)}">in ${esc(tokens(read))} <span class="muted">(${hit}% from cache)</span> · out ${esc(tokens(m.output))} · $${m.costUsd.toFixed(2)}</span>`,
      ]);
    }
  } else if (s.tokens) {
    rows.push(["Tokens", `in ${esc(tokens(s.tokens.input))} <span class="muted">(${esc(tokens(s.tokens.cachedInput))} from cache)</span> · out ${esc(tokens(s.tokens.output))}`]);
  }
  if (setup) {
    const servers = setup.mcpServers.map((m) => (m.status === "connected" ? m.name : `${m.name} (${m.status})`));
    rows.push(
      ["MCP servers", list(servers)],
      ["Plugins", list(setup.plugins)],
      ["Agents", list(setup.agents)],
      ["Tools", `<span title="${esc(setup.tools.join(", "))}">${setup.tools.length} available</span>`],
    );
  }
  rows.push(["Folder", `<span class="mono">${esc(s.worktree ? s.worktree.cwd : s.cwd)}</span>`]);
  const started = state.now - s.createdAt;
  return section("Session", `started ${esc(durationLabel(started))} ago`, kv(rows));
}

// -- context ----------------------------------------------------------------

function context(c: InspectContext | undefined, s: Session, openable: boolean): string {
  if (!c) {
    if (!s.context) return "";
    const { usedTokens: used, limitTokens: limit } = s.context;
    return section("Context", `${esc(tokens(used))} of ${esc(tokens(limit))}`, `<div class="insp-note">The breakdown arrives with the next turn.</div>`);
  }
  const pct = Math.round((c.usedTokens / c.limitTokens) * 100);
  const compact = c.autoCompactAt ? ` · compacts at ${esc(tokens(c.autoCompactAt))}` : "";
  const summary = `${esc(tokens(c.usedTokens))} of ${esc(tokens(c.limitTokens))} · ${pct}%${compact}`;

  // Colour follows the category, in the order Claude Code lists them; any past the palette fold into Other.
  const used = c.categories.filter((x) => x.kind === "used");
  const shown = used.slice(0, SERIES).map((x, n) => ({ name: x.name, tokens: x.tokens, cls: `s${n + 1}` }));
  const rest = used.slice(SERIES).reduce((sum, x) => sum + x.tokens, 0);
  if (rest) shown.push({ name: "Other", tokens: rest, cls: "other" });
  for (const x of c.categories) {
    if (x.kind === "buffer") shown.push({ name: x.name, tokens: x.tokens, cls: "buffer" });
    if (x.kind === "free") shown.push({ name: x.name, tokens: x.tokens, cls: "free" });
  }
  const share = (n: number) => (n / c.limitTokens) * 100;
  const bar = shown
    .map((x) => {
      const title = `${x.name}: ${x.tokens.toLocaleString()} tokens (${share(x.tokens).toFixed(1)}%)`;
      return `<span class="insp-seg insp-${x.cls}" style="flex-grow:${x.tokens}" title="${esc(title)}"></span>`;
    })
    .join("");
  const legend = shown
    .map(
      (x) =>
        `<div class="insp-legend-row"><span class="insp-swatch insp-${x.cls}"></span><span class="ellipsis grow">${esc(x.name)}</span><span class="insp-num">${esc(tokens(x.tokens))}</span><span class="insp-num muted">${share(x.tokens).toFixed(1)}%</span></div>`,
    )
    .join("");

  const parts = [`<div class="insp-bar" role="img" aria-label="${esc(`Context: ${summary}`)}">${bar}</div><div class="insp-legend">${legend}</div>`];
  if (c.memoryFiles.length) {
    const rows = c.memoryFiles.map(
      (f) => `<div class="insp-row insp-row-3">${fileLink(f.path, f.path, openable)}<span class="muted">${esc(f.type)}</span><span class="insp-num">${esc(tokens(f.tokens))}</span></div>`,
    );
    parts.push(sub("Memory files", `${c.memoryFiles.length}`, rows.join("")));
  }
  if (c.toolTokens.length) {
    const rows = c.toolTokens.map((t) => `<div class="insp-row insp-row-2"><span class="ellipsis">${esc(t.name)}</span><span class="insp-num">${esc(tokens(t.tokens))}</span></div>`);
    parts.push(sub("Tool calls and results", "tokens in the conversation", rows.join("")));
  }
  if (c.mcpTools.length) {
    const byServer = new Map<string, { count: number; tokens: number }>();
    for (const t of c.mcpTools) {
      const e = byServer.get(t.server) || { count: 0, tokens: 0 };
      e.count += 1;
      e.tokens += t.tokens;
      byServer.set(t.server, e);
    }
    const rows = [...byServer].map(
      ([server, e]) => `<div class="insp-row insp-row-3"><span class="ellipsis">${esc(server)}</span><span class="muted">${e.count} tools</span><span class="insp-num">${esc(tokens(e.tokens))}</span></div>`,
    );
    parts.push(sub("MCP tools", `${c.mcpTools.length}`, rows.join("")));
  }
  for (const [title, items] of [
    ["Skills", c.skills],
    ["Agents", c.agents],
  ] as const) {
    if (!items.length) continue;
    const rows = items.map(
      (x) => `<div class="insp-row insp-row-3"><span class="ellipsis">${esc(x.name)}</span><span class="muted ellipsis">${esc(x.source)}</span><span class="insp-num">${esc(tokens(x.tokens))}</span></div>`,
    );
    parts.push(sub(title, `${items.length}`, rows.join("")));
  }
  return section("Context", summary, parts.join(""));
}

function sub(title: string, summary: string, body: string): string {
  return `<div class="insp-sub"><div class="insp-sub-head">${esc(title)}<span class="muted">${esc(summary)}</span></div>${body}</div>`;
}

// -- files ------------------------------------------------------------------

function files(tools: InspectTool[], openable: boolean): string {
  const byPath = new Map<string, { shown: string; reads: number; changes: number; tokens: number; by: Set<string> }>();
  for (const t of tools) {
    if (!t.path) continue;
    const f = byPath.get(t.path) || { shown: t.target || t.path, reads: 0, changes: 0, tokens: 0, by: new Set<string>() };
    if (t.kind === "read") {
      f.reads += 1;
      f.tokens += t.resultTokens || 0;
    } else f.changes += 1;
    f.by.add(t.agent || "main");
    byPath.set(t.path, f);
  }
  if (!byPath.size) return section("Files", "none yet", `<div class="insp-note">No files read or changed yet.</div>`);
  const all = [...byPath.values()];
  const summary = `${all.length} · ${all.filter((f) => f.reads).length} read · ${all.filter((f) => f.changes).length} changed`;
  const rows = [...byPath].map(([path, f]) => {
    const did = [f.reads ? `read ${f.reads}×` : "", f.changes ? `changed ${f.changes}×` : ""].filter(Boolean).join(" · ");
    const by = [...f.by].filter((b) => b !== "main");
    const tags = by.map((b) => `<span class="mode-tag" title="Also by the subagent “${esc(b)}”">${esc(b)}</span>`).join("");
    const size = f.tokens ? `~${esc(tokens(f.tokens))}` : "";
    return `<div class="insp-row insp-row-files">${fileLink(path, f.shown, openable)}<span class="insp-tags">${tags}</span><span class="muted">${did}</span><span class="insp-num" title="Roughly what reading it added to the context">${size}</span></div>`;
  });
  return section("Files", summary, `<div class="insp-rows">${rows.join("")}</div>`);
}

// -- tool calls -------------------------------------------------------------

function took(t: InspectTool): number | undefined {
  return t.endedAt !== undefined ? t.endedAt - t.startedAt : undefined;
}

function toolRow(t: InspectTool, openable: boolean): string {
  const ms = took(t);
  const target = t.path ? fileLink(t.path, t.target, openable) : `<span class="mono ellipsis" title="${esc(t.target)}">${esc(t.target)}</span>`;
  const agent = t.agent ? `<span class="mode-tag" title="Called by the subagent “${esc(t.agent)}”">${esc(t.agent)}</span>` : "";
  const failed = t.ok === false ? `<span class="insp-failed">failed</span>` : "";
  const size = t.resultTokens ? `~${esc(tokens(t.resultTokens))}` : "";
  return `<div class="insp-row insp-row-tool">
    <span class="muted insp-num">${esc(clock(t.startedAt))}</span>
    <span class="ellipsis" title="${esc(t.name)}">${esc(t.label || t.name)}</span>
    <span class="insp-target">${agent}${target}${failed}</span>
    <span class="insp-num">${ms !== undefined ? esc(durationLabel(ms)) : ""}</span>
    <span class="insp-num muted" title="Roughly what the result added to the context">${size}</span>
  </div>`;
}

function toolCalls(tools: InspectTool[], openable: boolean): string {
  if (!tools.length) return "";
  const bySub = tools.filter((t) => t.agent).length;
  const failed = tools.filter((t) => t.ok === false).length;
  const summary = [`${tools.length}`, bySub ? `${bySub} by subagents` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  const slowest = tools
    .filter((t) => (took(t) || 0) >= 1000)
    .sort((a, b) => (took(b) || 0) - (took(a) || 0))
    .slice(0, 5);
  const heaviest = tools
    .filter((t) => (t.resultTokens || 0) >= 500)
    .sort((a, b) => (b.resultTokens || 0) - (a.resultTokens || 0))
    .slice(0, 5);
  const parts: string[] = [];
  if (slowest.length) parts.push(sub("Slowest", "", slowest.map((t) => toolRow(t, openable)).join("")));
  if (heaviest.length) parts.push(sub("Largest results", "", heaviest.map((t) => toolRow(t, openable)).join("")));
  const shown = tools.slice(-MAX_ROWS);
  const cut = tools.length - shown.length;
  parts.push(sub("All calls", cut ? `latest ${shown.length}, ${cut} earlier not shown` : "oldest first", shown.map((t) => toolRow(t, openable)).join("")));
  return section("Tool calls", summary, parts.join(""));
}

// -- events -----------------------------------------------------------------

const EVENT_LABEL: Record<InspectEvent["kind"], string> = {
  turn: "Turn",
  compact: "Compaction",
  retry: "Retry",
  hook: "Hook",
  denied: "Denied",
  approval: "You",
  memory: "Memory",
  subagent: "Subagent",
  limit: "Limit",
  error: "Error",
};

function events(list: InspectEvent[]): string {
  if (!list.length) return "";
  const rows = list.map((e) => {
    const detail = e.detail ? `<div class="insp-detail">${esc(e.detail)}</div>` : "";
    return `<div class="insp-event"><span class="muted insp-num">${esc(clock(e.at))}</span><span class="mode-tag">${esc(EVENT_LABEL[e.kind])}</span><div class="insp-event-text">${esc(e.text)}${detail}</div></div>`;
  });
  return section("Events", `${list.length}`, `<div class="insp-rows">${rows.join("")}</div>`);
}
