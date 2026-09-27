import { minutesLabel, type ApprovalDecision } from "../api/types";
import type { ToWebview, UiState } from "../panel/protocol";
import { answersFor, renderChat } from "./chat";
import { bindComposerOnce, insertText, refreshChips, renderComposer } from "./composer";
import { renderSessions } from "./sessions";
import { renderUsage, usageOpen } from "./usage";
import { local, post, selected } from "./state";
import { elapsed } from "./util";

let state: UiState | undefined;
let shellBuilt = false;
/**
 * What each pane last rendered. A pane is only replaced when its HTML changes,
 * so another session streaming doesn't swap out the chat mid-scroll.
 */
let leftHtml = "";
let chatHtml = "";
/**
 * Whether the chat keeps scrolling to the newest output. Scrolling up turns it
 * off; scrolling back to the bottom turns it on again.
 */
let followOutput = true;
let lastScrollTop = 0;
let followedSessionId: string | undefined;
const app = document.getElementById("app") as HTMLDivElement;

function buildShell(layout: UiState["layout"]): void {
  app.innerHTML =
    layout === "wide"
      ? `<div class="col col-left" id="left"></div><div class="col"><div id="chat"></div>${renderComposer()}</div>`
      : `<div id="left"></div><div id="chat" class="chat-wrap"></div>${renderComposer()}`;
  bindComposerOnce(() => state);
  shellBuilt = true;
}

function renderLeft(s: UiState): void {
  const left = document.getElementById("left");
  const html = `${renderUsage(s)}${renderSessions(s)}`;
  if (!left || html === leftHtml) return;
  left.innerHTML = html;
  leftHtml = html;
}

function render(): void {
  if (!state) return;
  if (!shellBuilt) buildShell(state.layout);

  renderLeft(state);
  refreshChips(state);

  const chat = document.getElementById("chat");
  const html = renderChat(state);
  if (!chat || html === chatHtml) return;
  const messages = document.getElementById("messages");
  // Catch a scroll the user made since the last scroll event, before the element is replaced.
  if (messages) trackScroll(messages);
  if (state.selectedSessionId !== followedSessionId) {
    followedSessionId = state.selectedSessionId;
    followOutput = true;
  }
  const prevScroll = messages ? messages.scrollTop : 0;
  const active = document.activeElement as HTMLInputElement | null;
  const typing = active && active.classList.contains("question-other") ? { qid: active.dataset.qid, at: active.selectionStart } : undefined;

  chat.outerHTML = `<div id="chat" class="chat-wrap">${html}</div>`;
  chatHtml = html;
  restoreTyped(typing);

  const nextMessages = document.getElementById("messages");
  if (nextMessages) {
    nextMessages.scrollTop = followOutput ? nextMessages.scrollHeight : prevScroll;
    lastScrollTop = nextMessages.scrollTop;
  }
  updatePinned();
}

/** Puts typed answers back after a redraw, and the cursor where it was. */
function restoreTyped(typing: { qid?: string; at: number | null } | undefined): void {
  document.querySelectorAll<HTMLInputElement>("#chat .question-other").forEach((input) => {
    const typed = local.typed[input.dataset.id || ""];
    input.value = (typed && typed[input.dataset.qid || ""]) || "";
    if (typing && typing.qid === input.dataset.qid) {
      input.focus();
      const at = typing.at === null ? input.value.length : typing.at;
      input.setSelectionRange(at, at);
    }
  });
}

/** Sends the answers, or none to have the agent ask in a message, and forgets the picks. */
function answer(sessionId: string, skip: boolean): void {
  const s = state && state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const answers = skip ? undefined : answersFor(s);
  if (!skip && !answers) return;
  delete local.picks[sessionId];
  delete local.typed[sessionId];
  post({ type: "answer", sessionId, answers });
}

/** A one-pick question takes one option; picking one clears an answer typed for it. */
function pickOption(sessionId: string, qid: string, label: string): void {
  const s = state && state.sessions.find((x) => x.id === sessionId);
  const qs = (s && s.pendingQuestions) || [];
  const q = qs.find((x) => x.id === qid);
  if (!q) return;
  const picks = local.picks[sessionId] || (local.picks[sessionId] = {});
  const picked = picks[qid] || [];
  if (q.multiSelect) {
    picks[qid] = picked.includes(label) ? picked.filter((x) => x !== label) : picked.concat(label);
  } else {
    picks[qid] = [label];
    const typed = local.typed[sessionId];
    if (typed) delete typed[qid];
  }
  // A single one-pick question is answered by the click itself.
  if (qs.length === 1 && !q.multiSelect) return answer(sessionId, false);
  render();
}

function trackScroll(box: HTMLElement): void {
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 2) followOutput = true;
  else if (box.scrollTop < lastScrollTop) followOutput = false;
  lastScrollTop = box.scrollTop;
}

/**
 * Marks the pinned user message as stuck once the messages before it have
 * scrolled out of view, and as clamped when its text is cut off.
 */
function updatePinned(): void {
  const box = document.getElementById("messages");
  const pin = box && (box.querySelector(".msg-pinned") as HTMLElement | null);
  if (!box || !pin) return;
  const bubble = pin.querySelector(".bubble") as HTMLElement;
  pin.classList.toggle("clamped", !pin.classList.contains("expanded") && bubble.scrollHeight > bubble.clientHeight + 1);
  const top = box.getBoundingClientRect().top;
  const prev = pin.previousElementSibling;
  const stuck = prev ? prev.getBoundingClientRect().bottom <= top : box.scrollTop > 0;
  pin.classList.toggle("stuck", stuck && pin.getBoundingClientRect().top <= top + 1);
}

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  if (!e.data) return;
  if (e.data.type === "state") {
    state = e.data.state;
    render();
  } else if (e.data.type === "focusInput") {
    const input = document.getElementById("input");
    if (input) input.focus();
  } else if (e.data.type === "insertText") {
    insertText(e.data.text);
  }
});

// Ticks the clocks on cards between state pushes.
setInterval(() => {
  if (!state) return;
  if (!state.sessions.some((s) => s.status === "running")) return;
  state.now = Date.now();
  renderLeft(state);
  const now = state.now;
  document.querySelectorAll<HTMLElement>("#chat [data-since]").forEach((el) => {
    el.textContent = elapsed(Number(el.dataset.since), now);
  });
}, 1000);

/** The phone has no VS Code input box, so it asks in the page. */
function askRunLimit(s: UiState, sessionId: string): void {
  const session = s.sessions.find((x) => x.id === sessionId);
  if (!session) return;
  const text = window.prompt("Stop the agent once a run has worked this long, e.g. 30m, 1h or 1h30m. Leave empty for no limit.", session.runLimitMs ? minutesLabel(session.runLimitMs) : "");
  if (text !== null) post({ type: "setRunLimit", sessionId, limit: text });
}

function messageText(mid: string): string {
  if (!state) return "";
  const m = state.messages.find((x) => x.id === mid);
  return m ? m.text : "";
}

app.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!target || !state) return;
  const action = target.dataset.action;
  const id = target.dataset.id || "";
  const mid = target.dataset.mid;
  switch (action) {
    case "select":
      if (id !== state.selectedSessionId) post({ type: "selectSession", sessionId: id });
      break;
    case "newSession":
      post({ type: "newSession" });
      break;
    case "openBrowser":
      post({ type: "openBrowser" });
      break;
    case "toggleRemote":
      post({ type: "toggleRemote" });
      break;
    case "fork":
      e.stopPropagation();
      post({ type: "fork", sessionId: id });
      break;
    case "forkAt":
      post({ type: "fork", sessionId: id, messageId: mid });
      break;
    case "stop":
      e.stopPropagation();
      post({ type: "stop", sessionId: id });
      break;
    case "approve":
      e.stopPropagation();
      post({ type: "approve", sessionId: id, decision: target.dataset.decision as ApprovalDecision });
      break;
    case "pickOption":
      pickOption(id, target.dataset.qid || "", target.dataset.label || "");
      break;
    case "answer":
      answer(id, false);
      break;
    case "skipQuestions":
      answer(id, true);
      break;
    case "complete":
      e.stopPropagation();
      post({ type: "complete", sessionId: id });
      break;
    case "toggleUsage":
      local.usageOpen = !usageOpen();
      render();
      break;
    case "toggleAllPast":
      post({ type: "toggleAllPast" });
      break;
    case "toggleKeepAwake":
      post({ type: "toggleKeepAwake" });
      break;
    case "toggleWorktree":
      local.worktree = !local.worktree;
      render();
      break;
    case "setRunLimit":
      if (state.remote) askRunLimit(state, id);
      else post({ type: "setRunLimit", sessionId: id });
      break;
    case "removeQueued":
      post({ type: "removeQueued", sessionId: id, queuedId: target.dataset.qid || "" });
      break;
    case "sendQueuedNow":
      post({ type: "sendQueuedNow", sessionId: id, queuedId: target.dataset.qid || "" });
      break;
    case "togglePin": {
      const expanded = local.expandedPin === mid;
      if (!expanded && !target.closest(".clamped")) break;
      local.expandedPin = expanded ? undefined : mid;
      render();
      break;
    }
    case "copy":
      if (mid) void navigator.clipboard.writeText(messageText(mid));
      break;
    case "openFile": {
      e.preventDefault();
      const line = target.dataset.line ? Number(target.dataset.line) : undefined;
      if (state.selectedSessionId && target.dataset.path) post({ type: "openFile", sessionId: state.selectedSessionId, path: target.dataset.path, line });
      break;
    }
    case "copyCode": {
      const block = target.closest(".code-block");
      const code = block && block.querySelector("code");
      if (code) void navigator.clipboard.writeText(code.textContent || "");
      target.textContent = "Copied";
      setTimeout(() => (target.textContent = "Copy"), 1200);
      break;
    }
  }
});

// Typing an answer: a one-pick question drops its picked option, since the typed text replaces it.
app.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  if (!input.classList.contains("question-other") || !state) return;
  const sessionId = input.dataset.id || "";
  const qid = input.dataset.qid || "";
  (local.typed[sessionId] || (local.typed[sessionId] = {}))[qid] = input.value;
  const s = selected(state);
  const q = s && s.pendingQuestions && s.pendingQuestions.find((x) => x.id === qid);
  const picks = local.picks[sessionId];
  if (q && !q.multiSelect && picks && input.value.trim()) delete picks[qid];
  render();
});

// ↵ in an answer box sends the answers once every question has one.
app.addEventListener("keydown", (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key !== "Enter" || e.isComposing || !input.classList.contains("question-other")) return;
  e.preventDefault();
  answer(input.dataset.id || "", false);
});

// #messages is replaced on every render, so listen in the capture phase on the stable root.
app.addEventListener(
  "scroll",
  (e) => {
    if ((e.target as HTMLElement).id === "messages") trackScroll(e.target as HTMLElement);
    updatePinned();
  },
  true,
);
// A wheel-up stops following right away, even if a render lands before the scroll event.
app.addEventListener("wheel", (e) => {
  if (e.deltaY < 0 && (e.target as HTMLElement).closest("#messages")) followOutput = false;
});

post({ type: "ready" });
