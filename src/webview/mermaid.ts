import type { Mermaid } from "mermaid";
import { esc } from "./util";

/**
 * Mermaid diagrams in chat. Mermaid is a few MB, so it lives in its own bundle
 * (dist/mermaid.js, next to this script) that loads the first time a chat has
 * a diagram.
 *
 * The chat is rendered again on every streamed token and morphed into place,
 * so a diagram can't be drawn into the page directly. It is drawn off to the
 * side, kept as an <img> keyed by its source, and the next render puts it in.
 * As an image its styles and ids stay out of the page, and nothing in it runs.
 */

// Read while this script runs; it is null afterwards.
const ownScript = document.currentScript as HTMLScriptElement | null;

/** An <img>, or null when the source isn't a diagram mermaid can draw (yet, while it streams in). */
const drawn = new Map<string, string | null>();
/** Diagrams the reader switched back to their source. */
const showSource = new Set<string>();

let onDrawn = (): void => {};
let loading: Promise<Mermaid> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let drawing = false;
let again = false;
let theme = "";
let nextId = 0;

/** Called once a diagram is ready, to render the chat again. */
export function onDiagramsDrawn(cb: () => void): void {
  onDrawn = cb;
}

export function toggleDiagramSource(source: string): void {
  if (showSource.has(source)) showSource.delete(source);
  else showSource.add(source);
}

export function isShowingSource(source: string): boolean {
  return showSource.has(source);
}

function currentTheme(): string {
  const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  return light ? "default" : "dark";
}

/**
 * The diagram for a finished `source` as an <img>, or undefined to show the
 * source as code. A source not tried yet is drawn after this render is in the
 * page, then the chat renders again.
 */
export function diagram(source: string): string | undefined {
  const img = drawn.get(`${currentTheme()}\0${source}`);
  if (img === undefined && !timer) {
    timer = setTimeout(() => {
      timer = undefined;
      void drawPending();
    }, 50);
  }
  return img || undefined;
}

function load(): Promise<Mermaid> {
  if (!loading) {
    loading = new Promise<Mermaid>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ownScript ? ownScript.src.replace(/webview\.js(\?.*)?$/, "mermaid.js") : "mermaid.js";
      if (ownScript && ownScript.nonce) script.nonce = ownScript.nonce;
      script.onload = () => resolve((window as unknown as { __relayMermaid: { default: Mermaid } }).__relayMermaid.default);
      script.onerror = () => reject(new Error("Couldn't load mermaid.js"));
      document.head.appendChild(script);
    });
  }
  return loading;
}

/** Draws every diagram the chat shows that isn't drawn yet. */
async function drawPending(): Promise<void> {
  if (drawing) {
    again = true;
    return;
  }
  drawing = true;
  try {
    const t = currentTheme();
    const sources = Array.from(document.querySelectorAll<HTMLElement>(".code-block[data-mermaid] code"))
      .map((code) => code.textContent || "")
      .filter((source) => !drawn.has(`${t}\0${source}`));
    if (!sources.length) return;
    let mermaid: Mermaid;
    try {
      mermaid = await load();
    } catch {
      for (const source of sources) remember(`${t}\0${source}`, null);
      return;
    }
    if (theme !== t) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: t as "default" | "dark", suppressErrorRendering: true });
      theme = t;
    }
    for (const source of new Set(sources)) remember(`${t}\0${source}`, await draw(mermaid, source));
    onDrawn();
  } finally {
    drawing = false;
    if (again) {
      again = false;
      void drawPending();
    }
  }
}

async function draw(mermaid: Mermaid, source: string): Promise<string | null> {
  try {
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
    const { svg } = await mermaid.render(`relay-mermaid-${nextId++}`, source);
    return toImg(svg);
  } catch {
    return null;
  }
}

/**
 * Mermaid sizes its <svg> to fill the page; as an image it needs its own
 * width and height. It shrinks to fit the chat, down to 60% before scrolling.
 */
function toImg(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  const root = doc.querySelector("svg");
  const box = root && root.viewBox.baseVal;
  if (!root || !box || !box.width) return null;
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.removeAttribute("style");
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
  return `<img class="mermaid-img" src="${esc(src)}" width="${width}" height="${height}" style="min-width: ${Math.round(width * 0.6)}px" alt="Diagram">`;
}

function remember(key: string, img: string | null): void {
  if (drawn.size > 100) drawn.clear();
  drawn.set(key, img);
}
