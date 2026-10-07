import * as crypto from "crypto";
import * as fs from "fs/promises";
import type * as http from "http";
import { createServer } from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import * as vscode from "vscode";
import type { SessionsApi } from "../api/SessionsApi";
import { PanelHost, type UiChannel } from "../panel/PanelHost";
import type { FromWebview, ToWebview } from "../panel/protocol";

const COOKIE = "relay_key";
/** A phone that drops off (screen locked, signal lost) comes back to the session it had open within this time. */
const RECONNECT_GRACE_MS = 10 * 60_000;
const MAX_CLIENTS = 20;
const MAX_BODY_BYTES = 1_000_000;
const ASSETS: Record<string, string> = { "/webview.js": "text/javascript; charset=utf-8", "/webview.css": "text/css; charset=utf-8", "/mermaid.js": "text/javascript; charset=utf-8" };

/** The page holds no data; everything comes over the authenticated API. */
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="theme-color" content="#181818">
  <link rel="stylesheet" href="webview.css">
  <title>Relay</title>
</head>
<body class="remote" data-layout="sidebar">
  <div id="app" class="app app-sidebar"></div>
  <script src="webview.js"></script>
</body>
</html>`;

// Inline styles: mermaid lays a diagram out in the page, with them, before it becomes an image.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** One phone's end of a PanelHost: state goes out on its event stream, commands come in as POSTs. */
class PhoneChannel implements UiChannel {
  private stream: http.ServerResponse | undefined;
  private listeners = new Set<(m: FromWebview) => void>();

  get connected(): boolean {
    return !!this.stream;
  }

  attach(stream: http.ServerResponse): void {
    if (this.stream) this.stream.end();
    this.stream = stream;
  }

  detach(stream: http.ServerResponse): void {
    if (this.stream === stream) this.stream = undefined;
  }

  post(msg: ToWebview): Thenable<unknown> {
    if (this.stream) this.stream.write(`data: ${JSON.stringify(msg)}\n\n`);
    return Promise.resolve();
  }

  onMessage(listener: (m: FromWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  receive(m: FromWebview): void {
    for (const listener of this.listeners) listener(m);
  }

  close(): void {
    if (this.stream) this.stream.end();
    this.stream = undefined;
  }
}

interface Client {
  channel: PhoneChannel;
  host: PanelHost;
  expire?: ReturnType<typeof setTimeout>;
}

/**
 * Serves Relay's UI to the phone on 127.0.0.1 only; Tailscale carries it to
 * the tailnet. Every API call needs the project's access key, taken once
 * from the QR code's link and kept as a cookie.
 */
export class RemoteServer {
  private readonly server = createServer((req, res) => {
    this.route(req, res).catch((err: unknown) => {
      console.error("Relay remote:", err);
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Something went wrong.");
      else res.end();
    });
  });
  /** Keyed by an id each open page makes up, so every phone tab keeps its own open session. */
  private clients = new Map<string, Client>();

  constructor(
    private readonly api: SessionsApi,
    private readonly distDir: string,
    private readonly key: () => string,
  ) {}

  /** Starts on a free port and returns it. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  /** Cuts off every phone, e.g. after the key changed; they have to sign in again. */
  disconnectAll(): void {
    for (const id of Array.from(this.clients.keys())) this.drop(id);
  }

  close(): void {
    this.disconnectAll();
    this.server.close();
    this.server.closeAllConnections();
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://relay");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /") return send(res, 200, "text/html; charset=utf-8", PAGE);
    if (req.method === "GET" && ASSETS[url.pathname]) {
      const body = await fs.readFile(path.join(this.distDir, url.pathname.slice(1)));
      return send(res, 200, ASSETS[url.pathname], body);
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, "text/plain; charset=utf-8", "Not found.");
    // Browsers only add a custom header to same-origin requests, so another site can't post here.
    if (req.method === "POST" && req.headers["x-relay"] !== "1") return send(res, 403);

    if (route === "POST /api/login") {
      if (!this.matches(await readBody(req))) return send(res, 401);
      res.setHeader("Set-Cookie", cookie(this.key(), secure(req)));
      return send(res, 204);
    }
    if (!this.matches(readCookie(req))) return send(res, 401);

    const clientId = url.searchParams.get("c") || "";
    if (!/^[A-Za-z0-9]{8,64}$/.test(clientId) && route !== "GET /api/check") return send(res, 400);
    switch (route) {
      case "GET /api/check":
        return send(res, 204);
      case "GET /api/events":
        return this.events(req, res, clientId);
      case "POST /api/command": {
        const client = this.clients.get(clientId);
        // The stream was dropped; the page reconnects and sends again.
        if (!client || !client.channel.connected) return send(res, 409);
        let msg: FromWebview;
        try {
          msg = JSON.parse(await readBody(req)) as FromWebview;
        } catch {
          return send(res, 400);
        }
        if (!msg || typeof msg.type !== "string") return send(res, 400);
        client.channel.receive(msg);
        return send(res, 204);
      }
    }
    return send(res, 404);
  }

  /** The state stream. A phone coming back within the grace period gets its open session back. */
  private events(req: http.IncomingMessage, res: http.ServerResponse, clientId: string): void {
    let client = this.clients.get(clientId);
    if (!client) {
      if (this.clients.size >= MAX_CLIENTS) this.dropOldestIdle();
      if (this.clients.size >= MAX_CLIENTS) return send(res, 503);
      const channel = new PhoneChannel();
      client = { channel, host: new PanelHost(channel, this.api, undefined, "sidebar", () => channel.connected, true) };
      this.clients.set(clientId, client);
    }
    if (client.expire) clearTimeout(client.expire);
    client.expire = undefined;

    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const current = client;
    current.channel.attach(res);
    current.host.refresh();
    // Keeps proxies and the phone's network from closing a quiet stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      current.channel.detach(res);
      if (!current.channel.connected && this.clients.get(clientId) === current) {
        current.expire = setTimeout(() => this.drop(clientId), RECONNECT_GRACE_MS);
      }
    });
  }

  private dropOldestIdle(): void {
    for (const [id, client] of this.clients) {
      if (!client.channel.connected) return this.drop(id);
    }
  }

  private drop(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    if (client.expire) clearTimeout(client.expire);
    client.channel.close();
    client.host.dispose();
  }

  private matches(candidate: string | undefined): boolean {
    if (!candidate) return false;
    // Hashing first makes both sides the same length, as timingSafeEqual needs.
    const a = crypto.createHash("sha256").update(candidate.trim()).digest();
    const b = crypto.createHash("sha256").update(this.key()).digest();
    return crypto.timingSafeEqual(a, b);
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function send(res: http.ServerResponse, status: number, type?: string, body?: string | Buffer): void {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, "Cache-Control": "no-store" };
  if (type) headers["Content-Type"] = type;
  if (type && type.startsWith("text/html")) headers["Content-Security-Policy"] = CSP;
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readCookie(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

/** Tailscale reaches the phone over HTTPS; only a browser on this Mac talks plain http to 127.0.0.1. */
function secure(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return req.headers["x-forwarded-proto"] === "https" || (host !== "127.0.0.1" && host !== "localhost");
}

function cookie(key: string, isSecure: boolean): string {
  const attrs = [`${COOKIE}=${encodeURIComponent(key)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${60 * 60 * 24 * 365}`];
  if (isSecure) attrs.push("Secure");
  return attrs.join("; ");
}
