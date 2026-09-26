import type { Readable, Writable } from "stream";

type EventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
}

/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe`: Chrome reads
 * commands on its fd 3 and writes replies and events on fd 4, each message
 * JSON ended by a NUL byte. No port is opened, so only Relay can drive it.
 */
export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listener: EventListener | undefined;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.receive(raw);
      }
    });
    input.on("close", () => this.close());
    out.on("error", () => this.close());
  }

  /** With a sessionId the command goes to that attached page instead of the browser. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser has closed."));
    const id = this.nextId++;
    const message: CdpMessage = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.out.write(JSON.stringify(message) + "\0");
    });
  }

  onEvent(listener: EventListener): void {
    this.listener = listener;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("The browser has closed."));
    this.pending.clear();
  }

  private receive(raw: string): void {
    let m: CdpMessage;
    try {
      m = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method && this.listener) {
      this.listener(m.method, m.params || {}, m.sessionId);
    }
  }
}
