import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Readable, Writable } from "stream";
import { findExecutable } from "../backend/binaries";
import { Cdp } from "./cdp";
import { PageLog } from "./pageLog";

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
  /** The window's inner size, e.g. "1280×800". */
  viewport?: string;
  /** Where the picture of the element and its surroundings was saved. */
  screenshot?: string;
  /** Console errors and failed requests since the page last loaded. */
  errors?: string[];
  failedRequests?: string[];
}

/** The picked element's box in the viewport, in CSS pixels. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room around the element in its screenshot, so the agent sees where it sits. */
const SHOT_MARGIN = 24;

export interface BrowserHost {
  /** The script injected into every page (dist/picker.js). */
  pickerSource(): string;
  /** Chats the popup offers, and the one to preselect. */
  targets(): Promise<{ targets: NoteTarget[]; selected?: string }>;
  /** Puts the note in front of the user; returns where it went, for the popup to confirm. */
  addNote(note: PageNote): Promise<string>;
  /** Keeps a screenshot for a note; returns its path, or undefined when there's nowhere to keep it. */
  saveScreenshot(png: Buffer): Promise<string | undefined>;
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
  /** What went wrong in each tab, by its CDP session. */
  private logs = new Map<string, PageLog>();

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
    } else if (method === "Target.detachedFromTarget") {
      this.logs.delete(params.sessionId as string);
    } else if (method === "Runtime.bindingCalled" && params.name === BINDING && sessionId) {
      await this.onBinding(cdp, sessionId, params.executionContextId as number, params.payload as string);
    } else if (sessionId) {
      const log = this.logs.get(sessionId);
      if (log) log.onEvent(method, params);
    }
  }

  private async preparePage(cdp: Cdp, session: string): Promise<void> {
    this.logs.set(session, new PageLog());
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Runtime.enable", {}, session);
    await cdp.send("Network.enable", {}, session);
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
      if (!note) {
        await reply("added", { ok: false, message: "Relay couldn't read this note." });
        return;
      }
      const log = this.logs.get(session);
      if (log && log.errors.length) note.errors = log.errors.slice();
      if (log && log.failedRequests.length) note.failedRequests = log.failedRequests.slice();
      const rect = readRect(m.rect);
      const png = rect ? await shot(cdp, session, rect).catch(() => undefined) : undefined;
      if (png) note.screenshot = await this.host.saveScreenshot(png).catch(() => undefined);
      try {
        await reply("added", { ok: true, message: `Added to ${await this.host.addNote(note)}` });
      } catch (e) {
        await reply("added", { ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

/**
 * The element with a margin around it, cut to the part in view (what the user
 * was looking at). The picker has hidden its own UI before asking.
 */
async function shot(cdp: Cdp, session: string, rect: Rect): Promise<Buffer | undefined> {
  const metrics = await cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, session);
  const view = metrics.cssLayoutViewport;
  const left = Math.max(0, rect.x - SHOT_MARGIN);
  const top = Math.max(0, rect.y - SHOT_MARGIN);
  const right = Math.min(view.clientWidth, rect.x + rect.width + SHOT_MARGIN);
  const bottom = Math.min(view.clientHeight, rect.y + rect.height + SHOT_MARGIN);
  if (right - left < 4 || bottom - top < 4) return undefined;
  // The clip is in page coordinates, so the scroll offset is added.
  const clip = { x: view.pageX + left, y: view.pageY + top, width: right - left, height: bottom - top, scale: 1 };
  const res = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip }, session);
  return Buffer.from(res.data, "base64");
}

function readRect(v: unknown): Rect | undefined {
  const r = v as Partial<Rect> | undefined;
  if (!r) return undefined;
  const ok = [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && isFinite(n));
  return ok ? (r as Rect) : undefined;
}

function readNote(m: Record<string, unknown>): PageNote | undefined {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const url = str(m.url, 2000);
  const selector = str(m.selector, 1000);
  const text = str(m.text, 200);
  const comment = str(m.comment, 10000);
  const sessionId = str(m.sessionId, 200);
  const viewport = str(m.viewport, 40);
  if (url === undefined || selector === undefined || text === undefined || !comment || sessionId === undefined) return undefined;
  return { url, selector, text, comment, sessionId, viewport };
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
