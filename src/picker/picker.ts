/**
 * Injected into every page of Relay's browser, in an isolated world: it shares
 * the page's DOM but not its scripts. The ✎ button (or ⌥⇧C) starts picking;
 * clicking an element opens a popup for a note, which goes to a Relay chat
 * through the `relayNote` binding. Relay answers by calling the exports below.
 *
 * No innerHTML or style attributes: pages with a strict CSP or Trusted Types
 * would block them. Styles go in through a constructed stylesheet instead.
 */

interface NoteTarget {
  id: string;
  title: string;
}

declare const relayNote: (payload: string) => void;

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 13px; line-height: 1.4; }
.fab { position: fixed; right: 16px; bottom: 16px; width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.15);
  background: #1f1f1f; color: #e6e6e6; cursor: pointer; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35); opacity: 0.75; pointer-events: auto; }
.fab:hover, .fab.on { opacity: 1; background: #0078d4; }
.fab svg { width: 16px; height: 16px; }
.box { position: fixed; border: 2px solid #0078d4; background: rgba(0,120,212,0.12); border-radius: 2px; pointer-events: none; }
.hint, .toast { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); background: #1f1f1f; color: #e6e6e6; padding: 6px 12px;
  border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); pointer-events: none; white-space: nowrap; }
.popup { position: fixed; width: 340px; background: #1f1f1f; color: #e6e6e6; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.45); padding: 10px; display: flex; flex-direction: column; gap: 8px; pointer-events: auto; }
.sel { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 11px; color: #9d9d9d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea { width: 100%; min-height: 64px; resize: vertical; background: #2a2a2a; color: #e6e6e6; border: 1px solid rgba(255,255,255,0.15);
  border-radius: 6px; padding: 6px 8px; outline: none; }
textarea:focus { border-color: #0078d4; }
.row { display: flex; align-items: center; gap: 6px; }
.grow { flex: 1; }
select { flex: 1; min-width: 0; background: #2a2a2a; color: #e6e6e6; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 3px 6px; }
button.btn { border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; background: #3a3a3a; color: #e6e6e6; }
button.primary { background: #0078d4; color: #fff; }
button.btn:disabled { opacity: 0.5; cursor: default; }
.status { color: #f48771; font-size: 12px; }
.status:empty { display: none; }
`;

const PENCIL = "M11 2.5l2.5 2.5L5.5 13H3v-2.5z";

/** Added to the page while picking, so everything shows a crosshair. */
const crosshair = new CSSStyleSheet();
crosshair.replaceSync("* { cursor: crosshair !important; }");

let mode: "idle" | "picking" | "commenting" = "idle";
let root: ShadowRoot | undefined;
let picked: Element | undefined;
const ui = {} as {
  fab: HTMLButtonElement;
  box: HTMLDivElement;
  hint: HTMLDivElement;
  toast: HTMLDivElement;
  popup: HTMLDivElement;
  sel: HTMLDivElement;
  comment: HTMLTextAreaElement;
  target: HTMLSelectElement;
  add: HTMLButtonElement;
  status: HTMLDivElement;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text) e.textContent = text;
  return e;
}

function show(e: HTMLElement, visible: boolean): void {
  e.style.display = visible ? "" : "none";
}

function build(): void {
  const host = document.createElement("relay-picker");
  const s = host.style;
  s.position = "fixed";
  s.inset = "0";
  s.zIndex = "2147483647";
  s.pointerEvents = "none";
  root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLES);
  root.adoptedStyleSheets = [sheet];

  ui.fab = el("button", "fab");
  ui.fab.title = "Comment on an element (⌥⇧C)";
  ui.fab.setAttribute("aria-label", "Comment on an element");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PENCIL);
  svg.appendChild(path);
  ui.fab.appendChild(svg);
  ui.fab.addEventListener("click", () => (mode === "idle" ? startPicking() : reset()));

  ui.box = el("div", "box");
  ui.hint = el("div", "hint", "Click an element to comment on it · Esc to cancel");
  ui.toast = el("div", "toast");

  ui.popup = el("div", "popup");
  ui.sel = el("div", "sel");
  ui.comment = el("textarea", "");
  ui.comment.placeholder = "What should change here?";
  ui.target = el("select", "");
  ui.target.setAttribute("aria-label", "Send to");
  ui.target.title = "Chat to add the note to";
  const cancel = el("button", "btn", "Cancel");
  cancel.addEventListener("click", reset);
  ui.add = el("button", "btn primary", "Add to chat");
  ui.add.addEventListener("click", submit);
  ui.status = el("div", "status");
  const row = el("div", "row");
  row.append(ui.target, cancel, ui.add);
  ui.popup.append(ui.sel, ui.comment, row, ui.status);
  // Clicks on our UI still bubble out of the shadow root; the page shouldn't see them.
  root.addEventListener("click", (e) => e.stopPropagation());

  root.append(ui.box, ui.popup, ui.hint, ui.toast, ui.fab);
  document.documentElement.appendChild(host);
  // Some frameworks replace everything under <html> while hydrating; put the button back.
  new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }).observe(document.documentElement, { childList: true });
  reset();
}

function reset(): void {
  mode = "idle";
  picked = undefined;
  ui.fab.classList.remove("on");
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== crosshair);
  for (const e of [ui.box, ui.hint, ui.popup]) show(e, false);
}

function startPicking(): void {
  reset();
  mode = "picking";
  ui.fab.classList.add("on");
  document.adoptedStyleSheets = document.adoptedStyleSheets.concat(crosshair);
  show(ui.hint, true);
  show(ui.toast, false);
}

function outline(target: Element | undefined): void {
  if (!target) {
    show(ui.box, false);
    return;
  }
  const r = target.getBoundingClientRect();
  ui.box.style.left = `${r.left}px`;
  ui.box.style.top = `${r.top}px`;
  ui.box.style.width = `${r.width}px`;
  ui.box.style.height = `${r.height}px`;
  show(ui.box, true);
}

function openPopup(target: Element): void {
  reset();
  mode = "commenting";
  picked = target;
  const selector = selectorFor(target);
  ui.sel.textContent = selector;
  ui.sel.title = selector;
  ui.comment.value = "";
  ui.status.textContent = "";
  ui.add.disabled = false;
  ui.target.textContent = "";
  ui.target.appendChild(new Option("Loading chats…", ""));
  ui.target.disabled = true;
  show(ui.popup, true);
  place();
  ui.comment.focus();
  relayNote(JSON.stringify({ type: "targets" }));
}

/** Below the element when there's room, else above; always inside the viewport. */
function place(): void {
  if (!picked) return;
  outline(picked);
  const r = picked.getBoundingClientRect();
  const w = ui.popup.offsetWidth;
  const h = ui.popup.offsetHeight;
  const gap = 8;
  let top = r.bottom + gap;
  if (top + h > innerHeight - gap) top = r.top - h - gap;
  top = Math.max(gap, Math.min(top, innerHeight - h - gap));
  const left = Math.max(gap, Math.min(r.left, innerWidth - w - gap));
  ui.popup.style.left = `${left}px`;
  ui.popup.style.top = `${top}px`;
}

function submit(): void {
  if (!picked || ui.add.disabled) return;
  const comment = ui.comment.value.trim();
  if (!comment) {
    ui.comment.focus();
    return;
  }
  ui.add.disabled = true;
  ui.status.textContent = "";
  relayNote(
    JSON.stringify({
      type: "note",
      url: location.href,
      selector: selectorFor(picked),
      text: visibleText(picked),
      comment,
      sessionId: ui.target.disabled ? "" : ui.target.value,
    }),
  );
}

function flash(message: string): void {
  ui.toast.textContent = message;
  show(ui.toast, true);
  setTimeout(() => show(ui.toast, false), 2500);
}

/** A selector that matches only this element: an id or test id when there is one, else a short path. */
function selectorFor(target: Element): string {
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const parts: string[] = [];
  let node: Element | null = target;
  while (node && node !== document.documentElement) {
    if (node.id && unique(`#${CSS.escape(node.id)}`)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const testId = node.getAttribute("data-testid");
    if (testId) {
      part += `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
    } else {
      // Plain class names only; utility classes like md:p-4 or w-[3px] are noise.
      const classes = Array.from(node.classList).filter((c) => /^[a-zA-Z][\w-]{0,29}$/.test(c)).slice(0, 2);
      part += classes.map((c) => `.${c}`).join("");
      const tag = node.tagName;
      const same = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === tag) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (unique(parts.join(" > "))) break;
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function visibleText(target: Element): string {
  const text = (target as HTMLElement).innerText || target.textContent || "";
  const label = text.trim() || target.getAttribute("aria-label") || target.getAttribute("placeholder") || target.getAttribute("alt") || "";
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

// -- called by Relay ------------------------------------------------------------

export function showTargets(data: { targets: NoteTarget[]; selected?: string }): void {
  if (mode !== "commenting") return;
  ui.target.textContent = "";
  ui.target.appendChild(new Option("New chat", ""));
  for (const t of data.targets) ui.target.appendChild(new Option(t.title, t.id));
  ui.target.value = data.selected && data.targets.some((t) => t.id === data.selected) ? data.selected : "";
  ui.target.disabled = false;
}

export function added(result: { ok: boolean; message: string }): void {
  if (!result.ok) {
    ui.status.textContent = result.message;
    ui.add.disabled = false;
    return;
  }
  reset();
  flash(result.message);
}

// -- start ---------------------------------------------------------------------

/**
 * Listening on window in the capture phase puts us ahead of all of the page's
 * listeners, since this script runs before any of the page's. While picking,
 * the page never sees the pointer; events on our own UI are hidden from it
 * too, so an app menu doesn't close on "click outside" and its shortcuts
 * don't fire while you type. Default actions, like focusing the textarea,
 * still happen. Clicks on our UI must reach it, so those are stopped at our
 * shadow root instead.
 */
function onPointer(e: Event): void {
  if (!root) return;
  if (e.target === root.host) {
    if (e.type !== "click") e.stopImmediatePropagation();
    return;
  }
  if (mode !== "picking") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === "click" && e.target instanceof Element) openPopup(e.target);
}

function onKey(e: KeyboardEvent): void {
  if (!root) return;
  if (e.type === "keydown" && e.altKey && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (mode === "idle") startPicking();
    else reset();
    return;
  }
  if (e.type === "keydown" && e.key === "Escape" && mode !== "idle") {
    e.preventDefault();
    e.stopImmediatePropagation();
    reset();
    return;
  }
  if (e.target !== root.host) return;
  e.stopImmediatePropagation();
  if (e.type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing && root.activeElement === ui.comment) {
    e.preventDefault();
    submit();
  }
}

// Only the top page gets a button; frames inside it are part of the same app.
if (window.top === window) {
  const capture = { capture: true, passive: false };
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "dblclick", "auxclick"]) {
    window.addEventListener(type, onPointer, capture);
  }
  for (const type of ["keydown", "keyup", "keypress"]) window.addEventListener(type, onKey as EventListener, capture);
  window.addEventListener(
    "mousemove",
    (e) => {
      if (mode !== "picking" || !root || e.target === root.host || !(e.target instanceof Element)) return;
      outline(e.target);
    },
    true,
  );
  window.addEventListener("scroll", () => mode === "commenting" && place(), true);
  window.addEventListener("resize", () => mode === "commenting" && place());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
}
