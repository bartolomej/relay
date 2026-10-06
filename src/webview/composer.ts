import { isActive, type Delivery, type Effort, type MessageMode, type ModelInfo, type ProviderId, type SessionOptions } from "../api/types";
import type { EditorSelection, UiState } from "../panel/protocol";
import { clearHint, currentHint, requestHint } from "./hints";
import { icons, providerMark } from "./icons";
import { bindMentions, closeMentions, mentionKeydown } from "./mentions";
import { composerOptions, local, newBrowser, newWorktree, post, selected } from "./state";
import { esc } from "./util";

/**
 * The composer is rendered once and then only its chips are refreshed, so
 * the textarea keeps whatever the user has typed while sessions stream.
 */
export function renderComposer(): string {
  return `<div class="composer">
    <div class="composer-box">
      <div class="mentions" id="mentions" hidden></div>
      <div class="context" id="context" hidden></div>
      <textarea id="input" rows="3" aria-label="Message" placeholder="Message…"></textarea>
      <div class="composer-bar" id="chips"></div>
    </div>
  </div>`;
}

/** What the context row last rendered, so it's only redrawn when the selection changes. */
let contextHtml = "";

function selectionKey(sel: EditorSelection): string {
  return JSON.stringify([sel.fsPath, sel.startLine, sel.endLine, sel.text]);
}

/** The live editor selection going with the next message, unless the user removed it, it was already sent, or it's also added. */
function offeredSelection(state: UiState): EditorSelection | undefined {
  const sel = state.selection;
  if (!sel) return undefined;
  const key = selectionKey(sel);
  return key !== local.usedSelection && !state.pinned.some((p) => selectionKey(p) === key) ? sel : undefined;
}

/** Everything that goes with the next message: the added selections, then the live one. */
function contextSelections(state: UiState): EditorSelection[] {
  const live = offeredSelection(state);
  return live ? [...state.pinned, live] : state.pinned;
}

/** One chip; `index` is an added selection's place, undefined for the live one. */
function contextChip(sel: EditorSelection, index?: number): string {
  const name = sel.path.split(/[\\/]/).pop() || sel.path;
  const lines = sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}`;
  const how = index === undefined ? "selected now, goes with your message" : "added, goes with your message";
  const title = `${sel.path}, lines ${lines}: ${how}${sel.text ? "" : " (too long to include; the agent reads those lines itself)"}`;
  const remove = `<button class="context-remove" data-pin="${index === undefined ? "" : index}" title="Don't include" aria-label="Don't include ${esc(name)} lines ${esc(lines)}">${icons.cross}</button>`;
  return `<span class="context-chip ${index === undefined ? "context-live" : ""}" title="${esc(title)}">${esc(name)} <span class="context-lines">(${esc(lines)})</span>${remove}</span>`;
}

function refreshContext(state: UiState): void {
  const el = document.getElementById("context");
  if (!el) return;
  const live = offeredSelection(state);
  const html = state.pinned.map((sel, i) => contextChip(sel, i)).join("") + (live ? contextChip(live) : "");
  if (html === contextHtml) return;
  el.innerHTML = html;
  el.hidden = !html;
  contextHtml = html;
}

/** The selection as the agent gets it after the message: the file and lines, and the code in a fence. */
function selectionContext(sel: EditorSelection): string {
  const where = `\`${sel.path}\` lines ${sel.startLine}-${sel.endLine}`;
  if (sel.text === undefined) return `Selected: ${where}`;
  // Longer than any run of backticks in the code, so the fence can't close early.
  const runs = sel.text.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `Selected: ${where}\n${fence}${sel.language}\n${sel.text.replace(/\n$/, "")}\n${fence}`;
}

/** What the chips last rendered; they're only redrawn when that changes, so an open dropdown stays open while sessions stream. */
let chipsHtml = "";

/** The provider's models, plus the session's own model if the live catalogue no longer lists it, so it stays selectable. */
function modelsFor(state: UiState, opts: SessionOptions): ModelInfo[] {
  const provider = state.providers.find((p) => p.id === opts.provider);
  const models: ModelInfo[] = provider ? provider.models.slice() : [];
  if (opts.model && !models.some((m) => m.id === opts.model)) models.unshift({ id: opts.model, label: opts.model, efforts: [] });
  return models;
}

export function refreshChips(state: UiState): void {
  const el = document.getElementById("chips");
  if (!el) return;
  refreshContext(state);
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (input) input.placeholder = placeholder(state);
  const opts = composerOptions(state);
  const models = modelsFor(state, opts);
  const model = models.find((m) => m.id === opts.model);
  const efforts: Effort[] = model ? model.efforts : [];

  const providerSel = `<span class="chip-wrap has-mark">${providerMark(opts.provider)}
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
  const modes: [MessageMode, string][] = [["normal", "Normal"], ["plan", "Plan"], ["ask", "Ask"]];
  const modeSel = `<select class="chip ${local.mode !== "normal" ? "chip-on" : ""}" id="chip-mode" aria-label="Mode" title="Plan: the agent asks questions before writing code, for one message. Ask: it only answers and can't change anything, until you switch back.">
      ${modes.map(([m, label]) => `<option value="${m}" ${local.mode === m ? "selected" : ""}>${label}</option>`).join("")}
    </select>`;

  // While the session works the button stops it; ↵ still queues a message.
  const working = selected(state);
  const action = working && isActive(working)
    ? `<button class="send stop" id="send" title="Stop (Esc)" aria-label="Stop the agent">${icons.stop}</button>`
    : `<button class="send" id="send" title="Send (↵)" aria-label="Send">${icons.send}</button>`;
  const html = `${providerSel}${modelSel}${effortSel}${modeSel}${hintChip(state, opts, models)}<span class="grow"></span>
    ${state.remote ? "" : `<button class="icon-btn" id="attach" title="Attach files" aria-label="Attach files">${icons.attach}</button>`}
    ${action}`;
  if (html === chipsHtml) return;
  el.innerHTML = html;
  chipsHtml = html;
}

const DIFFICULTY: Record<string, string> = { simple: "Simple", standard: "Standard", complex: "Complex", extreme: "Extreme" };

/** Jev's suggestion for the message being typed; in a started session just the effort. Clicking it switches to it; ⇧⌘↵ also sends. */
function hintChip(state: UiState, opts: SessionOptions, models: ModelInfo[]): string {
  const h = currentHint(state);
  if (!h) return "";
  const m = models.find((x) => x.id === h.model);
  const label = selected(state) && h.effort ? h.effort : `${m ? m.label : h.model}${h.effort ? ` · ${h.effort}` : ""}`;
  const difficulty = DIFFICULTY[h.difficulty] || h.difficulty;
  if (h.model === opts.model && (!h.effort || h.effort === opts.effort)) {
    return `<span class="model-hint fits" title="${esc(`Jev rates this message ${h.difficulty}, and the model picked is the one it suggests.`)}">${icons.check}${esc(difficulty)}</span>`;
  }
  const title = `Jev rates this message ${h.difficulty}. Click to switch to ${label}, or press ⇧⌘↵ to send with it.`;
  return `<button class="model-hint" id="model-hint" title="${esc(title)}" aria-label="${esc(title)}">${esc(difficulty)} → ${esc(label)}<span class="kbd">⇧⌘↵</span></button>`;
}

/** Switches the composer to Jev's suggestion; false when there's none to switch to. */
function applyHint(state: UiState): boolean {
  const h = currentHint(state);
  const opts = composerOptions(state);
  const m = h && modelsFor(state, opts).find((x) => x.id === h.model);
  if (!h || !m) return false;
  pickModel(opts, m);
  if (h.effort && m.efforts.includes(h.effort)) opts.effort = h.effort;
  refreshChips(state);
  return true;
}

/** A chip changed: the composer's options follow it. */
function onChipChange(state: UiState, chip: HTMLSelectElement): void {
  const opts = composerOptions(state);
  const v = chip.value;
  switch (chip.id) {
    case "chip-provider": {
      const p = state.providers.find((x) => x.id === (v as ProviderId));
      opts.provider = v as ProviderId;
      if (p && p.models.length && !p.models.some((m) => m.id === opts.model)) pickModel(opts, p.models[0]);
      // Suggestions are per provider; ask again for this one.
      requestHint(() => state, inputText());
      break;
    }
    case "chip-model": {
      const m = modelsFor(state, opts).find((x) => x.id === v);
      if (m) pickModel(opts, m);
      break;
    }
    case "chip-effort":
      opts.effort = v as Effort;
      break;
    case "chip-mode":
      local.mode = v as MessageMode;
      break;
  }
  refreshChips(state);
}

/** Switches model and keeps the effort if the new model accepts it, else its default. */
export function pickModel(opts: { model: string; effort: Effort }, m: ModelInfo): void {
  opts.model = m.id;
  if (m.efforts.length && !m.efforts.includes(opts.effort)) opts.effort = m.defaultEffort || m.efforts[Math.floor(m.efforts.length / 2)];
}

function placeholder(state: UiState): string {
  const s = selected(state);
  // A phone keyboard's return key adds a new line; the button sends.
  if (state.remote) return !s ? "Start a new session…" : isActive(s) ? "Queue a message…" : "Message this session…";
  if (!s) return "Start a new session…  ↵ send · ⇧↵ new line";
  if (isActive(s)) return "Queue a message…  ↵ queue · ⌘↵ interrupt and send · esc stop";
  return "Message this session…  ↵ send · ⇧↵ new line";
}

export function submit(state: UiState, delivery: Delivery = "queue"): void {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  closeMentions();
  const worktree = !state.selectedSessionId && newWorktree(state);
  const browser = !state.selectedSessionId && newBrowser(state);
  // Sent now, whether live or added, so it isn't offered again once the added ones are cleared.
  if (state.selection) local.usedSelection = selectionKey(state.selection);
  const context = contextSelections(state).map(selectionContext);
  post({ type: "send", sessionId: state.selectedSessionId, text: [text, ...context].join("\n\n"), options: { ...composerOptions(state) }, delivery, worktree, browser, mode: local.mode });
  input.value = "";
  clearHint();
  delete local.drafts[draftFor];
  autosize(input);
  local.composerFor = undefined;
  if (!state.selectedSessionId) {
    local.worktree = undefined;
    local.browser = undefined;
  }
  if (local.mode === "plan") local.mode = "normal";
  refreshChips(state);
}

let draftFor = "";

/** Each session keeps its own unsent text: switching sessions puts the old one's away and brings back the new one's. */
export function swapDraft(state: UiState): void {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  const next = state.selectedSessionId || "";
  if (!input || next === draftFor) return;
  closeMentions();
  clearHint();
  if (input.value) local.drafts[draftFor] = input.value;
  else delete local.drafts[draftFor];
  input.value = local.drafts[next] || "";
  draftFor = next;
  autosize(input);
}

/** Appends a block of text after what's already typed, a blank line between them. */
export function insertText(text: string): void {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!input) return;
  closeMentions();
  const typed = input.value.replace(/\s+$/, "");
  input.value = typed ? `${typed}\n\n${text}` : text;
  autosize(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = input.scrollHeight;
}

/** Fits the box to its text, up to the CSS max-height (10 lines); past that it scrolls. */
function autosize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const max = parseFloat(getComputedStyle(input).maxHeight);
  input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

function inputText(): string {
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  return input ? input.value : "";
}

function stop(sessionId: string): void {
  post({ type: "stop", sessionId });
}

export function bindComposerOnce(getState: () => UiState | undefined): void {
  // Bound once on the chips' box, so redrawing the chips needs no new listeners and these always see the latest state.
  const chips = document.getElementById("chips");
  if (chips) {
    chips.addEventListener("change", (e) => {
      const s = getState();
      if (s && e.target instanceof HTMLSelectElement) onChipChange(s, e.target);
    });
    chips.addEventListener("click", (e) => {
      const s = getState();
      if (s && (e.target as HTMLElement).closest("#model-hint")) {
        applyHint(s);
        return;
      }
      if (s && (e.target as HTMLElement).closest("#attach")) {
        post({ type: "attachFiles", sessionId: s.selectedSessionId });
        return;
      }
      if (!s || !(e.target as HTMLElement).closest("#send")) return;
      const working = selected(s);
      if (working && isActive(working)) stop(working.id);
      else submit(s);
    });
  }
  const context = document.getElementById("context");
  if (context) {
    context.addEventListener("click", (e) => {
      const s = getState();
      const btn = (e.target as HTMLElement).closest<HTMLElement>(".context-remove");
      if (!s || !btn) return;
      if (btn.dataset.pin) post({ type: "unpinSelection", index: Number(btn.dataset.pin) });
      else if (s.selection) {
        local.usedSelection = selectionKey(s.selection);
        refreshContext(s);
      }
    });
  }
  const input = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!input) return;
  input.addEventListener("input", () => {
    autosize(input);
    requestHint(getState, input.value);
  });
  bindMentions(getState);
  // ↵ sends (queued while the session works), ⌘↵ (Ctrl↵) interrupts and sends, ⇧⌘↵ sends with Jev's suggested model,
  // ⇧↵ or ⌥↵ is a new line, esc stops.
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || mentionKeydown(e)) return;
    if (e.key === "Escape") {
      const s = getState();
      const current = s && selected(s);
      if (current && isActive(current)) {
        e.preventDefault();
        stop(current.id);
      }
      return;
    }
    const s = getState();
    // On the phone, return is a new line and the button sends.
    if (e.key !== "Enter" || (s && s.remote)) return;
    e.preventDefault();
    if (s && e.shiftKey && (e.metaKey || e.ctrlKey) && applyHint(s)) {
      submit(s, "queue");
      return;
    }
    if (e.shiftKey || e.altKey) {
      input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
      autosize(input);
      return;
    }
    if (s) submit(s, e.metaKey || e.ctrlKey ? "interrupt" : "queue");
  });
}
