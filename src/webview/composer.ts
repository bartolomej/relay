import { isActive, type Delivery, type Effort, type MessageMode, type ModelInfo, type ProviderId } from "../api/types";
import type { UiState } from "../panel/protocol";
import { icons } from "./icons";
import { composerOptions, local, post, selected } from "./state";
import { esc } from "./util";

/**
 * The composer is rendered once and then only its chips are refreshed, so
 * the textarea keeps whatever the user has typed while sessions stream.
 */
export function renderComposer(): string {
  return `<div class="composer">
    <div class="composer-box">
      <textarea id="input" rows="3" aria-label="Message" placeholder="Message…"></textarea>
      <div class="composer-bar" id="chips"></div>
    </div>
  </div>`;
}

export function refreshChips(state: UiState): void {
  const el = document.getElementById("chips");
  if (!el) return;
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (input) input.placeholder = placeholder(state);
  const opts = composerOptions(state);
  const provider = state.providers.find((p) => p.id === opts.provider);
  // Keep a session's model selectable even if the live catalogue no longer lists it.
  const models: ModelInfo[] = provider ? provider.models.slice() : [];
  if (opts.model && !models.some((m) => m.id === opts.model)) models.unshift({ id: opts.model, label: opts.model, efforts: [] });
  const model = models.find((m) => m.id === opts.model);
  const efforts: Effort[] = model ? model.efforts : [];

  const providerSel = `<span class="chip-wrap has-dot"><span class="dot dot-${esc(opts.provider)}"></span>
    <select class="chip" id="chip-provider" aria-label="Provider">
      ${state.providers
        .map((p) => `<option value="${esc(p.id)}" ${p.id === opts.provider ? "selected" : ""} ${p.unavailable ? "disabled" : ""} title="${esc(p.unavailable || "")}">${esc(p.label)}${p.unavailable ? " (unavailable)" : ""}</option>`)
        .join("")}
    </select></span>`;
  const modelSel = `<select class="chip" id="chip-model" aria-label="Model">
      ${models.map((m) => `<option value="${esc(m.id)}" ${m.id === opts.model ? "selected" : ""} title="${esc(m.description || m.id)}">${esc(m.label)}</option>`).join("")}
    </select>`;
  const effortSel = efforts.length
    ? `<select class="chip" id="chip-effort" aria-label="Effort">
      ${efforts.map((e) => `<option value="${esc(e)}" ${e === opts.effort ? "selected" : ""}>${esc(e)}</option>`).join("")}
    </select>`
    : "";
  const modeSel = `<select class="chip ${local.mode === "plan" ? "chip-on" : ""}" id="chip-mode" aria-label="Mode" title="Plan: the agent asks questions before writing code">
      <option value="normal" ${local.mode === "normal" ? "selected" : ""}>Normal</option>
      <option value="plan" ${local.mode === "plan" ? "selected" : ""}>Plan</option>
    </select>`;

  // While the session works the button stops it; ↵ still queues a message.
  const working = selected(state);
  const action = working && isActive(working)
    ? `<button class="send stop" id="send" title="Stop (Esc)" aria-label="Stop the agent">${icons.stop}</button>`
    : `<button class="send" id="send" title="Send (↵)" aria-label="Send">${icons.send}</button>`;
  el.innerHTML = `${providerSel}${modelSel}${effortSel}${modeSel}<span class="grow"></span>
    <button class="icon-btn" title="Attach" aria-label="Attach file">${icons.attach}</button>
    ${action}`;

  const onChange = (id: string, fn: (v: string) => void) => {
    const s = document.getElementById(id) as HTMLSelectElement | null;
    if (s) s.addEventListener("change", () => fn(s.value));
  };
  onChange("chip-provider", (v) => {
    const p = state.providers.find((x) => x.id === (v as ProviderId));
    opts.provider = v as ProviderId;
    if (p && p.models.length && !p.models.some((m) => m.id === opts.model)) pickModel(opts, p.models[0]);
    refreshChips(state);
  });
  onChange("chip-model", (v) => {
    const m = models.find((x) => x.id === v);
    if (m) pickModel(opts, m);
    refreshChips(state);
  });
  onChange("chip-effort", (v) => (opts.effort = v as Effort));
  onChange("chip-mode", (v) => {
    local.mode = v as MessageMode;
    refreshChips(state);
  });
  const send = document.getElementById("send");
  if (send) send.addEventListener("click", () => (working && isActive(working) ? stop(working.id) : submit(state)));
}

/** Switches model and keeps the effort if the new model accepts it, else its default. */
function pickModel(opts: { model: string; effort: Effort }, m: ModelInfo): void {
  opts.model = m.id;
  if (m.efforts.length && !m.efforts.includes(opts.effort)) opts.effort = m.defaultEffort || m.efforts[Math.floor(m.efforts.length / 2)];
}

function placeholder(state: UiState): string {
  const s = selected(state);
  if (!s) return "Start a new session…  ↵ send · ⌥↵ new line";
  if (isActive(s)) return "Queue a message…  ↵ queue · ⇧↵ interrupt and send · esc stop";
  return "Message this session…  ↵ send · ⌥↵ new line";
}

export function submit(state: UiState, delivery: Delivery = "queue"): void {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const worktree = !state.selectedSessionId && state.worktrees && local.worktree;
  post({ type: "send", sessionId: state.selectedSessionId, text, options: { ...composerOptions(state) }, delivery, worktree, mode: local.mode });
  input.value = "";
  autosize(input);
  local.composerFor = undefined;
  if (!state.selectedSessionId) local.worktree = false;
  if (local.mode !== "normal") {
    local.mode = "normal";
    refreshChips(state);
  }
}

/** Fits the box to its text, up to the CSS max-height (10 lines); past that it scrolls. */
function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const max = parseFloat(getComputedStyle(input).maxHeight);
  input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

function stop(sessionId: string): void {
  post({ type: "stop", sessionId });
}

export function bindComposerOnce(getState: () => UiState | undefined): void {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!input) return;
  input.addEventListener("input", () => autosize(input));
  // ↵ sends (queued while the session works), ⇧↵ interrupts and sends, ⌥↵ is a new line, esc stops.
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      const s = getState();
      const current = s && selected(s);
      if (current && isActive(current)) {
        e.preventDefault();
        stop(current.id);
      }
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.altKey) {
      input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
      autosize(input);
      return;
    }
    const s = getState();
    if (s) submit(s, e.shiftKey ? "interrupt" : "queue");
  });
}
