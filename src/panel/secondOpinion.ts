import type { Message, ProviderId, Session } from "../api/types";

/** Only the latest requests; older ones are usually superseded. */
const MAX_REQUESTS = 5;
const MAX_REQUEST_CHARS = 1500;
const MAX_REPLY_CHARS = 2500;

const NAMES: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * The first message of a second-opinion session, for the user to edit and send.
 * The other provider can't read this conversation, so it gets what the agent was
 * asked, what it said at the end and which files it changed, and is told where
 * to find the changes.
 */
export function secondOpinionDraft(session: Session, messages: Message[]): string {
  const agent = NAMES[session.options.provider];
  const requests = messages.filter((m) => m.role === "user" && m.text.trim()).slice(-MAX_REQUESTS);
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim());
  const files = new Set<string>();
  for (const m of messages) for (const t of m.tools || []) if ((t.kind === "edit" || t.kind === "write") && t.target) files.add(t.target);

  const parts = [`Give me a second opinion on what another agent (${agent}) did in this project. Review it; don't change any files.`];
  if (requests.length) {
    const asked = requests.map((m) => quote(cut(m.text, MAX_REQUEST_CHARS))).join("\n\n");
    parts.push(`What it was asked${requests.length > 1 ? ", oldest first" : ""}:\n\n${asked}`);
  }
  if (reply) parts.push(`What it said at the end:\n\n${quote(cut(reply.text, MAX_REPLY_CHARS))}`);
  if (files.size) parts.push(`Files it changed: ${[...files].join(", ")}`);
  const where = session.worktree
    ? `It worked on the branch ${session.worktree.branch}, off ${session.worktree.base}; \`git diff ${session.worktree.base}...HEAD\` and \`git status\` show everything it changed.`
    : "Its changes are in this folder: look at `git status` and `git diff`, and `git log` for anything it committed.";
  parts.push(
    `${where} Check them against what was asked and list real problems, most serious first: bugs, missed requirements, edge cases, security. If it looks right, say so.`,
  );
  return parts.join("\n\n");
}
