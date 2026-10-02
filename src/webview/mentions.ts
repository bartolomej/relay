import type { UiState } from "../panel/protocol";
import { post } from "./state";
import { esc } from "./util";

/**
 * Typing @ in the message box opens a file search. Everything typed after it,
 * spaces included, is the query, until Esc closes it or a file is picked; the
 * pick replaces the @ and the query with the file's relative path.
 */

/** Where the open search's @ is in the message box; -1 while closed. */
let at = -1;
let query = "";
let paths: string[] = [];
let active = 0;
/** Results only count for the latest query; older ones that arrive late are dropped. */
let seq = 0;
let timer: number | undefined;

function box(): HTMLElement | null {
  return document.getElementById("mentions");
}

function input(): HTMLTextAreaElement | null {
  return document.getElementById("input") as HTMLTextAreaElement | null;
}

export function bindMentions(getState: () => UiState | undefined): void {
  const el = input();
  const list = box();
  if (!el || !list) return;
  el.addEventListener("input", (e) => {
    const s = getState();
    if (!s || s.remote) return;
    const typed = e as InputEvent;
    const caret = el.selectionStart;
    if (at < 0 && typed.inputType === "insertText" && typed.data === "@" && (caret === 1 || /\s/.test(el.value[caret - 2]))) {
      at = caret - 1;
      query = "";
      paths = [];
      search(s);
      return;
    }
    follow(s);
  });
  // Moving the caret before the @ closes the search.
  el.addEventListener("click", () => {
    const s = getState();
    if (s) follow(s);
  });
  el.addEventListener("keyup", (e) => {
    const s = getState();
    if (s && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) follow(s);
  });
  // Keeps the focus in the message box while a row is clicked.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (row) pick(Number(row.dataset.i));
  });
}

/** Keeps the query in step with the text after the @, or closes the search once that @ is gone. */
function follow(s: UiState): void {
  const el = input();
  if (at < 0 || !el) return;
  const caret = el.selectionStart;
  if (el.value[at] !== "@" || caret <= at) return closeMentions();
  const next = el.value.slice(at + 1, caret);
  if (next === query) return;
  query = next;
  search(s);
}

function search(s: UiState): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    seq += 1;
    post({ type: "searchFiles", sessionId: s.selectedSessionId, query, seq });
  }, 40);
}

export function showFileResults(forSeq: number, found: string[]): void {
  if (at < 0 || forSeq !== seq) return;
  paths = found;
  active = 0;
  render();
}

function render(): void {
  const list = box();
  if (!list) return;
  list.innerHTML = paths.length
    ? paths
        .map((p, i) => {
          const slash = p.lastIndexOf("/");
          const dir = slash >= 0 ? p.slice(0, slash) : "";
          return `<div class="mention${i === active ? " active" : ""}" data-i="${i}" title="${esc(p)}"><span class="mention-name">${esc(p.slice(slash + 1))}</span><span class="mention-dir">${esc(dir)}</span></div>`;
        })
        .join("")
    : `<div class="mention-empty">No matching files</div>`;
  list.hidden = false;
  const row = list.querySelector(".mention.active");
  if (row) row.scrollIntoView({ block: "nearest" });
}

/** Handles the keys the open search owns: ↑ ↓ to move, ↵ or Tab to pick, Esc to close. False when it's not open or not one of those. */
export function mentionKeydown(e: KeyboardEvent): boolean {
  if (at < 0) return false;
  const plainEnter = e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
  if (e.key === "Escape") closeMentions();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!paths.length) return true;
    active = (active + (e.key === "ArrowDown" ? 1 : paths.length - 1)) % paths.length;
    render();
  } else if (plainEnter || e.key === "Tab") {
    // With nothing found, ↵ still doesn't send: the search stays open until Esc.
    if (paths.length) pick(active);
  } else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function pick(i: number): void {
  const el = input();
  const p = paths[i];
  if (!el || p === undefined) return;
  const from = at;
  closeMentions();
  el.setRangeText(`${p} `, from, el.selectionStart, "end");
  // Lets the message box resize to its new text.
  el.dispatchEvent(new Event("input"));
  el.focus();
}

export function closeMentions(): void {
  at = -1;
  query = "";
  paths = [];
  seq += 1;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const list = box();
  if (list) {
    list.hidden = true;
    list.innerHTML = "";
  }
}
