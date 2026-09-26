import type { FromWebview, ToWebview } from "../panel/protocol";

const RETRY_MS = 3000;

/**
 * The phone's link to the extension, in place of VS Code's message passing:
 * state arrives on a server-sent event stream and commands go back as POSTs.
 * The access key comes from the QR code's link (after #, so it never leaves
 * the phone) and is exchanged for a cookie. Messages are delivered as window
 * "message" events, just like in VS Code, so the rest of the UI can't tell.
 */
export function connectRemote(): (m: FromWebview) => void {
  const client = randomId();
  const pending: FromWebview[] = [];
  let source: EventSource | undefined;
  let opened = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const deliver = (msg: ToWebview) => window.dispatchEvent(new MessageEvent("message", { data: msg }));

  function send(m: FromWebview): void {
    fetch(`api/command?c=${client}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Relay": "1" },
      body: JSON.stringify(m),
      credentials: "same-origin",
    })
      .then((res) => {
        if (res.status === 401) locked();
        else if (!res.ok) notice("Your Mac didn't get that. Try again.");
      })
      .catch(() => notice("Can't reach your Mac. That wasn't sent."));
  }

  async function connect(): Promise<void> {
    retry = undefined;
    try {
      const key = keyFromLink();
      if (key) {
        const login = await fetch("api/login", { method: "POST", headers: { "X-Relay": "1", "Content-Type": "text/plain" }, body: key, credentials: "same-origin" });
        if (login.status === 401) return locked();
      }
      const check = await fetch("api/check", { credentials: "same-origin", cache: "no-store" });
      if (check.status === 401) return locked();
      if (!check.ok) throw new Error(String(check.status));
    } catch {
      notice("Can't reach your Mac. Retrying…");
      return retryLater();
    }
    const es = new EventSource(`api/events?c=${client}`);
    source = es;
    es.onopen = () => {
      notice(undefined);
      if (opened) return;
      opened = true;
      pending.splice(0).forEach(send);
    };
    es.onmessage = (e: MessageEvent<string>) => deliver(JSON.parse(e.data) as ToWebview);
    es.onerror = () => {
      // The browser retries a dropped stream on its own, but gives up on an error status.
      if (es.readyState !== EventSource.CLOSED) return notice("Reconnecting…");
      if (source === es) source = undefined;
      notice("Can't reach your Mac. Retrying…");
      retryLater();
    };
  }

  function retryLater(): void {
    if (!retry) retry = setTimeout(() => void connect(), RETRY_MS);
  }

  // A phone freezes pages in the background; come back right away when shown again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || source) return;
    if (retry) clearTimeout(retry);
    void connect();
  });

  void connect();
  return (m) => {
    if (opened) send(m);
    else pending.push(m);
  };
}

function keyFromLink(): string | undefined {
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, (b: number) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

/** A strip at the top of the page while the connection is down; undefined hides it. */
function notice(text: string | undefined): void {
  let el = document.getElementById("remote-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "remote-notice";
    el.className = "remote-notice";
    document.body.appendChild(el);
  }
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

function locked(): void {
  notice(undefined);
  const app = document.getElementById("app");
  if (app) app.innerHTML = `<div class="empty">This link has no valid access key. Turn on Remote in Relay on your Mac and scan the QR code again.</div>`;
}
