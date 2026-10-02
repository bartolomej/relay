import * as fs from "fs/promises";
import * as path from "path";
import type { Message, Session, SessionInspect } from "../api/types";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** One session and its messages, as saved in `<dir>/<session id>.json`. */
interface SessionFile {
  version: 1;
  session: Session;
  messages: Message[];
  /** What the inspector shows; only Claude sessions have it. */
  inspect?: SessionInspect;
}

/** The earlier single-file format, kept only to import from. */
interface Snapshot {
  version: 1;
  sessions: Session[];
  messages: Record<string, Message[]>;
}

/**
 * Sessions and their normalized messages, kept in memory and saved as one
 * JSON file per session in a directory (the project's `.relay/sessions`).
 * Only sessions whose content changed are rewritten. With no directory it is
 * purely in memory, as the mock uses it.
 */
export class SessionStore {
  readonly sessions = new Map<string, Session>();
  readonly messages = new Map<string, Message[]>();
  readonly inspects = new Map<string, SessionInspect>();
  /** Sessions that were mid-turn when the window closed or the extension restarted. */
  readonly interrupted: string[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** What each file last held, so unchanged sessions aren't rewritten. */
  private written = new Map<string, string>();

  /**
   * @param dir where the session files live (`<project>/.relay/sessions`)
   * @param projectRoot the project folder; sessions whose saved folder no longer
   *   exists (the project was moved or renamed) are pointed back at it
   */
  constructor(
    private readonly dir?: string,
    private readonly projectRoot?: string,
  ) {}

  async load(): Promise<void> {
    if (!this.dir) return;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(this.dir, name), "utf8");
      let file: SessionFile;
      try {
        file = JSON.parse(raw) as SessionFile;
      } catch {
        continue; // A half-written or hand-edited file shouldn't take the rest down.
      }
      this.written.set(file.session.id, raw);
      if (this.projectRoot && file.session.cwd !== this.projectRoot && !(await exists(file.session.cwd))) {
        // Claude and Codex resume by id, so only the working folder needs updating.
        file.session.cwd = this.projectRoot;
        file.session.folder = path.basename(this.projectRoot);
        this.save();
      }
      if (this.add(file.session, file.messages)) this.interrupted.push(file.session.id);
      if (file.inspect) this.inspects.set(file.session.id, file.inspect);
    }
  }

  /** Takes over the matching sessions of an old single-file snapshot, and saves them here. */
  async importSnapshot(file: string, keep: (s: Session) => boolean = () => true): Promise<number> {
    let snap: Snapshot;
    try {
      snap = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
    } catch {
      return 0;
    }
    const taken = snap.sessions.filter(keep);
    for (const s of taken) this.add(s, snap.messages[s.id] || []);
    if (taken.length) this.save();
    return taken.length;
  }

  put(session: Session, messages: Message[] = []): void {
    this.sessions.set(session.id, session);
    if (!this.messages.has(session.id)) this.messages.set(session.id, messages);
    this.save();
  }

  messagesOf(sessionId: string): Message[] {
    let list = this.messages.get(sessionId);
    if (!list) {
      list = [];
      this.messages.set(sessionId, list);
    }
    return list;
  }

  inspectOf(sessionId: string): SessionInspect {
    let inspect = this.inspects.get(sessionId);
    if (!inspect) {
      inspect = { tools: [], events: [] };
      this.inspects.set(sessionId, inspect);
    }
    return inspect;
  }

  save(): void {
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 500);
  }

  async flush(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    for (const session of this.sessions.values()) {
      const file: SessionFile = { version: 1, session, messages: this.messagesOf(session.id), inspect: this.inspects.get(session.id) };
      const json = JSON.stringify(file, null, 1);
      if (this.written.get(session.id) === json) continue;
      const target = path.join(this.dir, `${session.id}.json`);
      await fs.writeFile(`${target}.tmp`, json);
      await fs.rename(`${target}.tmp`, target);
      this.written.set(session.id, json);
    }
  }

  /** Returns whether the session was cut off mid-turn. */
  private add(s: Session, messages: Message[]): boolean {
    // Nothing survives a reload mid-turn: the provider process went with it.
    const cut = s.status === "running" || s.status === "waiting";
    if (cut) {
      s.status = "failed";
      s.unread = true;
      s.pendingApproval = undefined;
      s.pendingQuestions = undefined;
    }
    s.background = undefined;
    for (const m of messages) m.streaming = false;
    this.sessions.set(s.id, s);
    this.messages.set(s.id, messages);
    return cut;
  }
}
