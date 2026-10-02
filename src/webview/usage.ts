import type { ProviderUsage, UsageWindow } from "../api/types";
import type { UiState } from "../panel/protocol";
import { icons, providerMark } from "./icons";
import { local } from "./state";
import { esc, level, until } from "./util";

function label(state: UiState, u: ProviderUsage): string {
  const p = state.providers.find((x) => x.id === u.provider);
  return p ? p.label : u.provider;
}

function row(w: UsageWindow, now: number): string {
  const pct = Math.round(w.usedPercent);
  const reset = w.resetsAt
    ? `<span class="usage-reset" title="Resets ${esc(new Date(w.resetsAt).toLocaleString())}">${esc(until(w.resetsAt, now))}</span>`
    : `<span class="usage-reset"></span>`;
  const title = w.detail ? `${w.label}: ${w.detail}` : w.label;
  return `<div class="usage-row">
    <span class="usage-label ellipsis" title="${esc(title)}">${esc(w.label)}</span>
    <progress class="meter meter-${level(pct)}" max="100" value="${pct}" aria-label="${esc(w.label)}: ${pct}% used"></progress>
    <span class="usage-pct">${pct}%</span>
    ${reset}
  </div>`;
}

function provider(state: UiState, u: ProviderUsage): string {
  const extras = (u.extras || [])
    .map((x) => `<div class="usage-extra"><span class="ellipsis">${esc(x.label)}</span><span class="usage-extra-value">${esc(x.value)}</span></div>`)
    .join("");
  const body = u.windows.length || extras
    ? `${u.windows.map((w) => row(w, state.now)).join("")}${extras}`
    : `<div class="usage-note">${esc(u.note || "No usage data yet.")}</div>`;
  return `<div class="usage-provider">
    <div class="usage-name"><span class="dot dot-${esc(u.provider)}"></span><span>${esc(label(state, u))}</span>${u.plan ? `<span class="muted">${esc(u.plan)}</span>` : ""}</div>
    ${body}
  </div>`;
}

/** The rolling 5 hour window: Claude's "Session (5h)", Codex's "5h limit". */
function isSession(w: UsageWindow): boolean {
  return /\b5h\b/.test(w.label);
}

/**
 * Collapsed: the 5 hour window, then the fullest of the rest per provider,
 * since that's the one that will stop you. E.g. "<Claude mark> 5%/40%".
 */
function summary(state: UiState): string {
  return state.usage
    .filter((u) => u.windows.length)
    .map((u) => {
      const session = u.windows.find(isSession);
      const rest = u.windows.filter((w) => w !== session);
      const top = rest.length ? rest.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : undefined;
      const shown = [session, top].filter((w): w is UsageWindow => !!w);
      const pcts = shown.map((w) => Math.round(w.usedPercent));
      const name = label(state, u);
      const title = `${name} · ${shown.map((w, i) => `${w.label}: ${pcts[i]}%`).join(" / ")}`;
      return `<span class="usage-sum usage-sum-${level(Math.max(...pcts))}" title="${esc(title)}">${providerMark(u.provider)}<span>${pcts.map((p) => `${p}%`).join("/")}</span></span>`;
    })
    .join("");
}

/** Collapsed until the user opens it. */
export function usageOpen(): boolean {
  return local.usageOpen === true;
}

export function renderUsage(state: UiState): string {
  if (!state.usage.length) return "";
  const open = usageOpen();
  return `<div class="usage">
    <button class="usage-head ${open ? "open" : ""}" data-action="toggleUsage" aria-expanded="${open}">
      ${icons.chevron}<span>Status</span>${open ? "" : summary(state)}
    </button>
    ${open ? state.usage.map((u) => provider(state, u)).join("") : ""}
  </div>`;
}
