import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Readable, Writable } from "stream";
import { findExecutable } from "../backend/binaries";
import { Cdp } from "./cdp";

/**
 * The picker runs in an isolated world, like an extension's content script:
 * it shares the page's DOM but not its globals, and the binding it reports
 * through exists only there, so the page's own scripts can't send notes.
 */
const WORLD = "relay";
const BINDING = "relayNote";

export interface NoteTarget {
  id: string;
  title: string;
}

export interface PageNote {
  url: string;
  selector: string;
  /** The element's visible text, shortened; helps the agent find it in the source. */
  text: string;
  comment: string;
  /** Chat to add the note to; empty for a new one. */
  sessionId: string;
}

export interface BrowserHost {
  /** The script injected into every page (dist/picker.js). */
  pickerSource(): string;
  /** Chats the popup offers, and the one to preselect. */
  targets(): Promise<{ targets: NoteTarget[]; selected?: string }>;
  /** Puts the note in front of the user; returns where it went, for the popup to confirm. */
  addNote(note: PageNote): Promise<string>;
}

/**
 * A Chrome window of Relay's own, with its own profile, where any element can
 * be picked and commented on. Chrome allows one running instance per profile,
 * so each project gets its own profile folder.
 */
export class Browser {
  private proc: ChildProcess | undefined;
  private cdp: Cdp | undefined;
  private picker = "";
  /** Where the first page goes once the picker is set up in it. */
  private startUrl: string | undefined;

  constructor(
    private readonly profileDir: string,
    private readonly host: BrowserHost,
  ) {}

  get running(): boolean {
    return !!this.cdp;
  }

  /** Starts Chrome on the url, or opens the url in a new tab when it's already running. */
  async open(url: string, executable: string): Promise<void> {
    if (this.cdp) {
      await this.cdp.send("Target.createTarget", { url });
      return;
    }
    this.picker = this.host.pickerSource();
    this.startUrl = url;
    fs.mkdirSync(this.profileDir, { recursive: true });
    const proc = spawn(
      executable,
      [`--user-data-dir=${this.profileDir}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "about:blank"],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
    this.proc = proc;
    this.cdp = cdp;
    const exited = new Promise<never>((_, reject) => {
      const end = (message: string) => {
        cdp.close();
        if (this.proc === proc) {
          this.proc = undefined;
          this.cdp = undefined;
        }
        reject(new Error(message));
      };
      proc.on("error", (e) => end(`Couldn't start the browser: ${e.message}`));
      proc.on("exit", () => end("The browser closed while starting."));
    });
    // Only matters while starting; later exits just reset the state above.
    exited.catch(() => undefined);
    cdp.onEvent((method, params, sessionId) => void this.onEvent(cdp, method, params, sessionId));
    // Pages wait for us before running anything, so the picker is in place before the app loads.
    await Promise.race([cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }), exited]);
  }

  dispose(): void {
    const { proc, cdp } = this;
    if (!proc || !cdp) return;
    this.proc = undefined;
    this.cdp = undefined;
    cdp.send("Browser.close").catch(() => proc.kill());
  }

  private async onEvent(cdp: Cdp, method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    if (method === "Target.attachedToTarget") {
      const session = params.sessionId as string;
      const info = params.targetInfo as { type: string };
      try {
        if (info.type === "page") await this.preparePage(cdp, session);
        else await cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
      } catch {
        // The tab closed while we were setting it up.
      }
    } else if (method === "Runtime.bindingCalled" && params.name === BINDING && sessionId) {
      await this.onBinding(cdp, sessionId, params.executionContextId as number, params.payload as string);
    }
  }

  private async preparePage(cdp: Cdp, session: string): Promise<void> {
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Runtime.enable", {}, session);
    await cdp.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }, session);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.picker, worldName: WORLD }, session);
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, session);
    const url = this.startUrl;
    this.startUrl = undefined;
    if (url) await cdp.send("Page.navigate", { url }, session);
  }

  /** The picker asks for the chat list or sends a note; the answer is called back into its world. */
  private async onBinding(cdp: Cdp, session: string, contextId: number, payload: string): Promise<void> {
    const reply = (fn: string, value: unknown) =>
      cdp.send("Runtime.evaluate", { expression: `__relayPicker.${fn}(${JSON.stringify(value)})`, contextId }, session).catch(() => undefined);
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === "targets") {
      await reply("showTargets", await this.host.targets());
    } else if (m.type === "note") {
      const note = readNote(m);
      if (!note) return;
      try {
        await reply("added", { ok: true, message: `Added to ${await this.host.addNote(note)}` });
      } catch (e) {
        await reply("added", { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

function readNote(m: Record<string, unknown>): PageNote | undefined {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const url = str(m.url, 2000);
  const selector = str(m.selector, 1000);
  const text = str(m.text, 200);
  const comment = str(m.comment, 10000);
  const sessionId = str(m.sessionId, 200);
  if (url === undefined || selector === undefined || text === undefined || !comment || sessionId === undefined) return undefined;
  return { url, selector, text, comment, sessionId };
}

/** Chrome, or another Chromium browser, in its usual install location. */
export function findChrome(override?: string): string | undefined {
  if (override) return fs.existsSync(override) ? override : undefined;
  if (process.platform === "darwin") {
    const apps = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Brave Browser.app/Contents/MacOS/Brave Browser"];
    for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
      for (const app of apps) {
        const file = path.join(dir, app);
        if (fs.existsSync(file)) return file;
      }
    }
    return undefined;
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]];
    for (const root of roots) {
      if (!root) continue;
      for (const exe of ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"]) {
        const file = path.join(root, exe);
        if (fs.existsSync(file)) return file;
      }
    }
    return undefined;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const found = findExecutable(name);
    if (found) return found;
  }
  return undefined;
}
