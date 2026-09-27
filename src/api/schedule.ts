// When scheduled tasks run. Shared by the extension host and the webview, so
// no Node or VS Code imports.

import type { Schedule, TaskInput } from "./types";

/** A new task runs daily at 9 until changed. */
export const DEFAULT_SCHEDULE: Schedule = { repeat: "daily", time: "09:00", weekday: 1, day: 1 };
/** Nobody is watching a scheduled run, so one that hangs is stopped after this. */
export const DEFAULT_RUN_LIMIT_MS = 60 * 60 * 1000;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function runsOn(s: Schedule, d: Date): boolean {
  switch (s.repeat) {
    case "daily":
      return true;
    case "weekdays":
      return d.getDay() >= 1 && d.getDay() <= 5;
    case "weekly":
      return d.getDay() === s.weekday;
    case "monthly": {
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return d.getDate() === Math.min(s.day, lastDay);
    }
  }
}

/** The first time the schedule comes up after `after`, in local time. */
export function nextRun(s: Schedule, after: number): number {
  const [hours, minutes] = s.time.split(":").map(Number);
  const from = new Date(after);
  // Every schedule comes up within a month and a bit; a year is a safe bound.
  for (let i = 0; i < 400; i++) {
    const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hours, minutes);
    if (at.getTime() > after && runsOn(s, at)) return at.getTime();
  }
  throw new Error("The schedule never comes up.");
}

/** 1st, 2nd, 3rd, 11th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/** "Weekdays at 09:00", "Mondays at 18:30", "Monthly on the 1st at 07:00". */
export function scheduleLabel(s: Schedule): string {
  switch (s.repeat) {
    case "daily":
      return `Daily at ${s.time}`;
    case "weekdays":
      return `Weekdays at ${s.time}`;
    case "weekly":
      return `${WEEKDAYS[s.weekday]}s at ${s.time}`;
    case "monthly":
      return `Monthly on the ${ordinal(s.day)} at ${s.time}`;
  }
}

/** The task's name, or its prompt's first line when it has none. */
export function taskName(t: TaskInput): string {
  if (t.name) return t.name;
  const line = t.prompt.trim().split("\n")[0];
  return line.length > 48 ? `${line.slice(0, 45)}…` : line || "Untitled task";
}
