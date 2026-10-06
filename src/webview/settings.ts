import type { Difficulty, ModelInfo, ModelTiers, ProviderId, ProviderInfo, SessionOptions } from "../api/types";
import type { SettingKey, SettingsView, UiState } from "../panel/protocol";
import { pickModel } from "./composer";
import { icons, providerMark } from "./icons";
import { defaultOptions, post } from "./state";
import { esc } from "./util";

/**
 * The settings screen, in place of the chat. Every change is saved straight
 * to VS Code's `relay.*` settings; the screen redraws from what was saved.
 */

const LEVELS: Array<[Difficulty, string, string]> = [
  ["simple", "Simple", "A small, clearly specified change or command, or a quick question"],
  ["standard", "Standard", "A typical feature or bug fix touching a few files"],
  ["complex", "Complex", "Design, a refactor across many files, a bug with an unclear cause, or research"],
];

const NOTIFICATIONS: Array<[string, string]> = [
  ["all", "VS Code and macOS notifications"],
  ["inApp", "VS Code notifications only"],
  ["off", "No notifications, only the badge"],
];

/** Opens the settings in place of the chat, or goes back. */
export function settingsToggle(state: UiState): string {
  if (state.remote) return "";
  const on = state.showSettings;
  const title = on ? "Back to sessions" : "Settings";
  return `<button class="icon-btn ${on ? "on" : ""}" data-action="toggleSettings" title="${title}" aria-label="Settings" aria-pressed="${on}">${icons.gear}</button>`;
}

function option(value: string, label: string, on: boolean, extra = ""): string {
  return `<option value="${esc(value)}" ${on ? "selected" : ""} ${extra}>${esc(label)}</option>`;
}

/** The provider's models, plus the saved one if the catalogue doesn't list it, so it shows as saved. */
function modelsFor(provider: ProviderInfo, saved: string | undefined): ModelInfo[] {
  const models = provider.models.slice();
  if (saved && !models.some((m) => m.id === saved)) models.unshift({ id: saved, label: `${saved} (not listed)`, efforts: [] });
  return models;
}

function effortSelect(id: string, attrs: string, model: ModelInfo | undefined, effort: string | undefined): string {
  if (!model || !model.efforts.length) return "";
  const current = effort && model.efforts.includes(effort) ? effort : model.defaultEffort || model.efforts[0];
  return `<select class="chip" id="${id}" ${attrs} aria-label="Effort">${model.efforts.map((e) => option(e, e, e === current)).join("")}</select>`;
}

function check(key: string, on: boolean, label: string, disabled = false): string {
  return `<label class="check"><input type="checkbox" id="set-${key}" data-setting="${key}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""}> ${esc(label)}</label>`;
}

function text(key: SettingKey, value: string, placeholder = ""): string {
  return `<input class="field-input" id="set-${key}" data-setting="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">`;
}

function note(textHtml: string): string {
  return `<div class="setting-note">${textHtml}</div>`;
}

function section(title: string, body: string): string {
  return `<section class="settings-section"><div class="group-head"><span>${esc(title)}</span></div>${body}</section>`;
}

function tierRows(provider: ProviderInfo, tiers: ModelTiers): string {
  const mine = tiers[provider.id] || {};
  const rows = LEVELS.map(([level, name, hint]) => {
    const tier = mine[level] || {};
    const models = modelsFor(provider, tier.model);
    const model = models.find((m) => m.id === tier.model);
    const id = `tier-${provider.id}-${level}`;
    const attrs = `data-tier="${provider.id}.${level}"`;
    const modelSel = `<select class="chip" id="${id}-model" ${attrs} data-part="model" aria-label="${esc(`${name} model`)}">
        ${models.map((m) => option(m.id, m.label, m.id === tier.model, `title="${esc(m.description || m.id)}"`)).join("")}
        ${option("", "No suggestion", !tier.model)}
      </select>`;
    return `<div class="setting-tier"><span class="tier-name" title="${esc(hint)}">${esc(name)}</span>${modelSel}${effortSelect(`${id}-effort`, `${attrs} data-part="effort"`, model, tier.effort)}</div>`;
  }).join("");
  return `<div class="field"><span class="field-label tier-provider">${providerMark(provider.id)}${esc(provider.label)}</span>${rows}</div>`;
}

function hintsSection(state: UiState, s: SettingsView): string {
  const providers = state.providers.filter((p) => !p.unavailable && p.models.length);
  const key = s.jevKey
    ? `<span class="muted">TypeSafe API key saved in the system keychain.</span><button class="btn" data-action="setJevKey">Change key…</button>`
    : `<span class="muted">No TypeSafe API key yet; turning suggestions on asks for one.</span><button class="btn" data-action="setJevKey">Set key…</button>`;
  return section(
    "Model suggestions",
    `${check("modelHints", s.modelHints, "Suggest a model for each message")}
    ${note("As you type, Jev rates how hard the message looks and the model for that difficulty shows next to the model dropdown. After a session's first message it keeps the model and suggests only the effort (low, medium, high, or xhigh when hard work keeps failing), which keeps the prompt cache. <b>⇧⌘↵</b> sends with it. What you type is sent to TypeSafe.")}
    <div class="field-row">${key}</div>
    ${providers.length ? providers.map((p) => tierRows(p, s.modelHintModels)).join("") : note("The models show once Claude Code or Codex is available.")}`,
  );
}

function newSessionSection(state: UiState, s: SettingsView): string {
  const opts = defaultOptions(state);
  const provider = state.providers.find((p) => p.id === opts.provider);
  const models = provider ? modelsFor(provider, opts.model) : [];
  const model = models.find((m) => m.id === opts.model);
  const attrs = `data-setting="newSessionModel"`;
  const providerSel = `<span class="chip-wrap has-mark">${providerMark(opts.provider)}
      <select class="chip" id="set-newSessionModel-provider" ${attrs} data-part="provider" aria-label="Provider">
        ${state.providers.map((p) => option(p.id, p.unavailable ? `${p.label} (unavailable)` : p.label, p.id === opts.provider, p.unavailable ? "disabled" : "")).join("")}
      </select></span>`;
  const modelSel = `<select class="chip" id="set-newSessionModel-model" ${attrs} data-part="model" aria-label="Model">
      ${models.map((m) => option(m.id, m.label, m.id === opts.model, `title="${esc(m.description || m.id)}"`)).join("")}
    </select>`;
  const worktreeNote = state.worktrees ? "" : note("This project isn't a git repository, so its sessions work in the project folder.");
  return section(
    "New sessions",
    `<div class="field"><span class="field-label">Start with</span>
      <div class="field-row">${providerSel}${modelSel}${effortSelect("set-newSessionModel-effort", `${attrs} data-part="effort"`, model, opts.effort)}</div></div>
    ${check("newSessionWorktree", s.newSessionWorktree, "Work in their own git worktree, merged back on Complete", !state.worktrees)}
    ${worktreeNote}
    ${check("newSessionBrowser", s.newSessionBrowser, "Let the agent use Relay's browser")}
    ${note("The toggles in a new session's header still switch these for that session. Scheduled tasks pick their own.")}`,
  );
}

function modesSection(s: SettingsView): string {
  return section(
    "Plan and Ask",
    `<label class="field"><span class="field-label">Plan mode</span>
      <textarea class="field-input" id="set-planPrompt" data-setting="planPrompt" rows="6">${esc(s.planPrompt)}</textarea></label>
    <label class="field"><span class="field-label">Ask mode</span>
      <textarea class="field-input" id="set-askPrompt" data-setting="askPrompt" rows="4">${esc(s.askPrompt)}</textarea></label>
    ${note("Added to the end of a message sent in that mode; the chat shows only what you typed.")}`,
  );
}

function outputFormatSection(s: SettingsView): string {
  return section(
    "Output format",
    `${check("outputFormat", s.outputFormat, "Add output format instructions to every message")}
    <label class="field"><span class="field-label">Instructions</span>
      <textarea class="field-input" id="set-outputFormatPrompt" data-setting="outputFormatPrompt" rows="5">${esc(s.outputFormatPrompt)}</textarea></label>
    ${note("Added to the end of every message, after the Plan or Ask instruction; the chat shows only what you typed.")}`,
  );
}

function generalSection(state: UiState, s: SettingsView): string {
  const notifications = `<select class="chip" id="set-notifications" data-setting="notifications" aria-label="Notifications">${NOTIFICATIONS.map(([v, label]) => option(v, label, v === s.notifications)).join("")}</select>`;
  return section(
    "Notifications and power",
    `<div class="field"><span class="field-label">When a session finishes, fails or needs you</span><div class="field-row">${notifications}</div></div>
    ${state.keepAwake !== undefined ? check("keepAwake", s.keepAwake, "Keep the computer awake while an agent works") : ""}`,
  );
}

function toolsSection(s: SettingsView): string {
  const path = (key: SettingKey, label: string, value: string) => `<label class="field"><span class="field-label">${esc(label)}</span>${text(key, value, "Found automatically")}</label>`;
  return section(
    "Tools",
    `<label class="field"><span class="field-label">Title model</span>${text("titleModel", s.titleModel)}</label>
    ${note("Codex model that titles each session from your latest message. Without Codex, the title is the message's first line.")}
    ${path("claudePath", "Claude Code", s.claudePath)}
    ${path("codexPath", "Codex", s.codexPath)}
    ${path("chromePath", "Chrome or another Chromium browser", s.chromePath)}
    ${path("tailscalePath", "Tailscale", s.tailscalePath)}
    <div class="field"><span class="field-label">Backend</span><div class="field-row">
      <select class="chip" id="set-backend" data-setting="backend" aria-label="Backend">${option("real", "Claude Code and Codex", s.backend === "real")}${option("mock", "Mock agents, for UI work", s.backend === "mock")}</select>
      <span class="muted">Takes effect after reloading the window.</span></div></div>`,
  );
}

function settingsHtml(state: UiState, s: SettingsView): string {
  return `<div class="chat-head"><span class="title grow">Settings</span>
      <button class="btn" data-action="openVsCodeSettings" title="Every Relay setting, in VS Code's Settings editor">Open in VS Code Settings</button>
      <button class="btn btn-primary" data-action="toggleSettings">Done</button></div>
    <div class="settings-body">
      ${hintsSection(state, s)}
      ${newSessionSection(state, s)}
      ${generalSection(state, s)}
      ${modesSection(s)}
      ${outputFormatSection(s)}
      ${toolsSection(s)}
    </div>`;
}

/** What the pane last drew. Cleared on every change, so the next push redraws from what was actually saved. */
let paneHtml = "";

/**
 * Redrawn only when what it shows changes, keeping the scroll position and
 * whatever is being typed in a text box.
 */
export function renderSettings(state: UiState): void {
  const el = document.getElementById("settings");
  if (!el || !state.settings) return;
  const html = settingsHtml(state, state.settings);
  if (html === paneHtml) return;
  const body = el.querySelector(".settings-body");
  const scroll = body ? body.scrollTop : 0;
  const active = document.activeElement;
  const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.id && el.contains(active) ? active : undefined;
  const focusId = active instanceof HTMLElement && el.contains(active) ? active.id : "";
  const typed = typing ? { value: typing.value, start: typing.selectionStart, end: typing.selectionEnd } : undefined;
  el.innerHTML = html;
  paneHtml = html;
  const next = el.querySelector(".settings-body");
  if (next) next.scrollTop = scroll;
  const again = focusId ? document.getElementById(focusId) : null;
  if (!again) return;
  if (typed && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && again.type !== "checkbox") {
    again.value = typed.value;
    again.setSelectionRange(typed.start, typed.end);
  }
  again.focus();
}

/** Saves a changed control: text once it's committed, choices once made. */
export function onSettingChange(state: UiState, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const s = state.settings;
  if (!s) return;
  paneHtml = "";
  if (el.dataset.tier) {
    post({ type: "setSetting", key: "modelHintModels", value: changedTiers(state, s.modelHintModels, el) });
    return;
  }
  const key = el.dataset.setting;
  if (!key) return;
  if (key === "modelHints") post({ type: "toggleModelHints" });
  else if (key === "newSessionModel") post({ type: "setSetting", key, value: changedDefault(state, el) });
  else if (el instanceof HTMLInputElement && el.type === "checkbox") post({ type: "setSetting", key: key as SettingKey, value: el.checked });
  else post({ type: "setSetting", key: key as SettingKey, value: el instanceof HTMLInputElement ? el.value.trim() : el.value });
}

/** The tiers with one model or effort changed. A new model keeps the effort if it takes it, else gets its default. */
function changedTiers(state: UiState, tiers: ModelTiers, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): ModelTiers {
  const [pid, level] = (el.dataset.tier || "").split(".") as [string, Difficulty];
  const next: ModelTiers = JSON.parse(JSON.stringify(tiers));
  const mine = next[pid] || (next[pid] = {});
  const tier = { ...(mine[level] || {}) };
  if (el.dataset.part === "effort") tier.effort = el.value;
  else {
    const provider = state.providers.find((p) => p.id === pid);
    const m = provider && provider.models.find((x) => x.id === el.value);
    const opts = { model: el.value, effort: tier.effort || "" };
    if (m) pickModel(opts, m);
    tier.model = opts.model;
    tier.effort = m && m.efforts.length ? opts.effort : undefined;
  }
  mine[level] = tier;
  return next;
}

/** The new-session agent with the provider, model or effort changed. */
function changedDefault(state: UiState, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): SessionOptions {
  const next: SessionOptions = { ...defaultOptions(state) };
  const v = el.value;
  if (el.dataset.part === "provider") {
    const p = state.providers.find((x) => x.id === v);
    next.provider = v as ProviderId;
    if (p && p.models.length) pickModel(next, p.models[0]);
  } else if (el.dataset.part === "model") {
    const p = state.providers.find((x) => x.id === next.provider);
    const m = p && p.models.find((x) => x.id === v);
    if (m) pickModel(next, m);
  } else next.effort = v;
  return next;
}
