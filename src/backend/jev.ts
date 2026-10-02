import type { Difficulty } from "../api/types";

/**
 * Jev, TypeSafe's decision model: it answers typed questions about a text
 * with probabilities instead of writing any. Relay asks it one question, how
 * hard a message is, to suggest a model for it.
 */

const BASE_URL = "https://api.typesafe.ai/v1";
const MODEL = "jev-latest";
const TIMEOUT_MS = 10 * 1000;
const MAX_INPUT = 4000;

const LEVELS: Difficulty[] = ["simple", "standard", "complex"];

const QUESTION = {
  type: "score",
  instructions: "How hard is this request for an AI coding agent working in the user's project?",
  criteria: [
    "Simple: a small, clearly specified change or command, e.g. tweak a style or some UI text, rename something, run a command, commit, or answer a quick factual question",
    "Standard: a typical feature or bug fix with a clear path, touching a few files",
    "Complex: open-ended, abstract or risky work, e.g. design or architecture, a refactor across many files, a bug with an unclear cause, or research weighing trade-offs",
  ],
};

export class JevError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How hard the message looks. Throws a JevError when Jev answers with an error. */
export async function rateDifficulty(key: string, text: string): Promise<Difficulty> {
  const body = { model: MODEL, state: text.slice(0, MAX_INPUT), questions: { difficulty: QUESTION } };
  const res = await call(key, "/systemone", { method: "POST", body: JSON.stringify(body) });
  const data = (await res.json()) as { answers?: { difficulty?: { score?: number } } };
  const score = data.answers && data.answers.difficulty ? data.answers.difficulty.score : undefined;
  if (typeof score !== "number") throw new JevError(res.status, "Jev's answer had no difficulty score.");
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, Math.round(score)))];
}

/** Whether TypeSafe accepts the key. Listing the models sends no text to Jev. */
export async function checkKey(key: string): Promise<boolean> {
  try {
    await call(key, "/models", { method: "GET" });
    return true;
  } catch (err) {
    if (err instanceof JevError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
}

async function call(key: string, path: string, init: { method: string; body?: string }): Promise<Response> {
  const res = await fetch(BASE_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new JevError(res.status, `Jev answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}
