const MAX_ENTRIES = 10;
const MAX_LINE = 300;
/** Requests still open; a page that never finishes some shouldn't grow this forever. */
const MAX_OPEN_REQUESTS = 500;

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  /** A logged object's first few properties. */
  preview?: { properties: Array<{ name: string; value?: string }>; overflow: boolean };
}

function line(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
}

function describe(arg: RemoteObject): string {
  if (arg.type === "string" && typeof arg.value === "string") return arg.value;
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  // An Error's description is its message and stack; a plain object's is just "Object".
  if (arg.preview && arg.subtype !== "error") {
    const props = arg.preview.properties.map((p) => (arg.subtype === "array" ? String(p.value) : `${p.name}: ${p.value}`));
    const more = arg.preview.overflow ? ", …" : "";
    return arg.subtype === "array" ? `[${props.join(", ")}${more}]` : `{${props.join(", ")}${more}}`;
  }
  return (arg.description || arg.unserializableValue || arg.type || "").split("\n")[0];
}

/**
 * Console errors and failed requests of one tab since its last navigation,
 * from the CDP events Relay already receives, so a note can say what went
 * wrong on the page besides what the user saw.
 */
export class PageLog {
  errors: string[] = [];
  failedRequests: string[] = [];
  private requests = new Map<string, string>();

  onEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Page.frameNavigated": {
        const frame = params.frame as { parentId?: string };
        if (!frame.parentId) this.reset();
        break;
      }
      case "Runtime.consoleAPICalled": {
        if (params.type !== "error" && params.type !== "assert") break;
        const args = (params.args as RemoteObject[]) || [];
        this.add(this.errors, args.map(describe).join(" "));
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails as { text: string; url?: string; lineNumber?: number; exception?: RemoteObject };
        const what = (d.exception && d.exception.description ? d.exception.description.split("\n")[0] : "") || d.text;
        const where = d.url ? ` (${d.url}${d.lineNumber !== undefined ? `:${d.lineNumber + 1}` : ""})` : "";
        this.add(this.errors, `Uncaught ${what}${where}`);
        break;
      }
      case "Network.requestWillBeSent": {
        const req = params.request as { url: string; method: string };
        // The browser asks for a favicon on its own; a missing one isn't the app's problem.
        if (req.url.startsWith("data:") || /\/favicon\.ico(\?|$)/.test(req.url)) break;
        if (this.requests.size >= MAX_OPEN_REQUESTS) this.requests.clear();
        this.requests.set(params.requestId as string, `${req.method} ${req.url}`);
        break;
      }
      case "Network.responseReceived": {
        const res = params.response as { status: number };
        const req = this.requests.get(params.requestId as string);
        if (req && res.status >= 400) this.add(this.failedRequests, `${req} → ${res.status}`);
        break;
      }
      case "Network.loadingFailed": {
        const req = this.requests.get(params.requestId as string);
        if (req && !params.canceled) this.add(this.failedRequests, `${req} → ${String(params.errorText || "failed")}`);
        this.requests.delete(params.requestId as string);
        break;
      }
      case "Network.loadingFinished":
        this.requests.delete(params.requestId as string);
        break;
    }
  }

  private reset(): void {
    this.errors = [];
    this.failedRequests = [];
    this.requests.clear();
  }

  private add(list: string[], text: string): void {
    list.push(line(text));
    if (list.length > MAX_ENTRIES) list.shift();
  }
}
