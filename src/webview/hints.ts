import type { ModelSuggestion, ProviderId } from "../api/types";
import type { UiState } from "../panel/protocol";
import { composerOptions, post, selected } from "./state";

/**
 * While model suggestions are on, a pause in typing asks Jev for a model for
 * the message; in a session that has started, only for an effort on its model.
 * A suggestion only counts for the session and provider it was asked for, and
 * is dropped once the message is sent.
 */

const DEBOUNCE_MS = 700;
/** Shorter messages are follow-ups like "yes" or "commit", too little to rate. */
const MIN_LENGTH = 12;

/** Answers only count for the latest request; older ones that arrive late are dropped. */
let seq = 0;
let timer: number | undefined;
let asked: { sessionId: string; provider: ProviderId } | undefined;
let hint: { sessionId: string; provider: ProviderId; suggestion: ModelSuggestion } | undefined;

/** The message box changed: asks again once typing pauses. */
export function requestHint(getState: () => UiState | undefined, text: string): void {
  window.clearTimeout(timer);
  const state = getState();
  if (!state || !state.modelHints) return;
  if (text.trim().length < MIN_LENGTH) {
    clearHint();
    return;
  }
  timer = window.setTimeout(() => {
    const s = getState();
    if (!s || !s.modelHints) return;
    seq++;
    asked = { sessionId: s.selectedSessionId || "", provider: composerOptions(s).provider };
    const session = selected(s);
    const model = session && session.options.provider === asked.provider ? session.options.model : undefined;
    post({ type: "suggestModel", seq, text: text.trim(), provider: asked.provider, model });
  }, DEBOUNCE_MS);
}

/** Jev answered; true when the suggestion shown changes. */
export function receiveHint(answerSeq: number, suggestion: ModelSuggestion | undefined): boolean {
  if (answerSeq !== seq || !asked) return false;
  const before = hint;
  hint = suggestion ? { ...asked, suggestion } : undefined;
  return before !== hint;
}

/** The suggestion for what's typed now, if it's for this session and provider. */
export function currentHint(state: UiState): ModelSuggestion | undefined {
  if (!hint || !state.modelHints) return undefined;
  if (hint.sessionId !== (state.selectedSessionId || "") || hint.provider !== composerOptions(state).provider) return undefined;
  return hint.suggestion;
}

export function clearHint(): void {
  window.clearTimeout(timer);
  seq++;
  hint = undefined;
}
