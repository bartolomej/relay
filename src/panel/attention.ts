import { execFile } from "child_process";
import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import { isActive, type Session, type SessionStatus } from "../api/types";

export type NotifyLevel = "all" | "inApp" | "off";

interface Hooks {
  /** Whether the user is looking at this session right now. */
  isViewing(sessionId: string): boolean;
  open(sessionId: string): void;
  setBadge(badge: vscode.ViewBadge | undefined): void;
  level(): NotifyLevel;
}

/**
 * Gets the user's attention when a session they aren't looking at finishes,
 * fails, or stops for an approval: a count on the activity bar icon, a VS Code
 * notification with an Open button, and a macOS notification when VS Code
 * isn't the focused app.
 */
export class Attention implements vscode.Disposable {
  private last = new Map<string, SessionStatus>();
  private unsubscribe: () => void;
  private checking = Promise.resolve();

  constructor(
    private readonly api: SessionsApi,
    private readonly hooks: Hooks,
  ) {
    this.unsubscribe = api.onDidChange(() => this.schedule(false));
    this.schedule(true);
  }

  dispose(): void {
    this.unsubscribe();
  }

  // Checks run one after another so two quick changes can't both announce the same finish.
  private schedule(initial: boolean): void {
    this.checking = this.checking.then(() => this.check(initial)).catch(() => undefined);
  }

  private async check(initial: boolean): Promise<void> {
    const sessions = await this.api.listSessions();
    for (const s of sessions) {
      const before = this.last.get(s.id);
      this.last.set(s.id, s.status);
      if (initial || before === undefined || this.hooks.isViewing(s.id)) continue;
      // A queued message starts the next turn right away, so the session stays active and nothing fires.
      const wasActive = before === "running" || before === "waiting";
      if (wasActive && !isActive(s) && s.unread) this.announce(s, s.status === "failed" ? "failed" : "finished");
      else if (before !== "waiting" && s.status === "waiting") this.announce(s, s.pendingQuestions ? "has a question" : "needs approval");
    }
    this.updateBadge(sessions);
  }

  private updateBadge(sessions: Session[]): void {
    const review = sessions.filter((s) => s.unread && !s.archived && !isActive(s)).length;
    const waiting = sessions.filter((s) => s.status === "waiting").length;
    const total = review + waiting;
    const parts = [review ? `${review} ready to review` : "", waiting ? `${waiting} waiting for you` : ""].filter(Boolean);
    this.hooks.setBadge(total ? { value: total, tooltip: parts.join(", ") } : undefined);
  }

  private announce(s: Session, what: "finished" | "failed" | "needs approval" | "has a question"): void {
    const level = this.hooks.level();
    if (level === "off") return;
    const detail =
      what === "needs approval" && s.pendingApproval
        ? `: ${s.pendingApproval.summary}`
        : what === "has a question" && s.pendingQuestions
          ? `: ${s.pendingQuestions[0].question}`
          : "";
    const text = `${s.title} ${what}${detail}`;
    const show = what === "finished" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(text, "Open").then((pick) => {
      if (pick) this.hooks.open(s.id);
    });
    if (level === "all" && !vscode.window.state.focused) systemNotification(`Session ${what}`, s.title);
  }
}

/** A macOS banner with a sound. Arguments go to osascript directly, never through a shell. */
function systemNotification(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  execFile("osascript", ["-e", `display notification ${quote(body)} with title "Relay" subtitle ${quote(title)} sound name "Glass"`], () => undefined);
}
