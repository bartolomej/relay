import markdownit, { type StateCore, type Token } from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { diagram, isShowingSource } from "./mermaid";
import { esc, htmlLinkContext, isHtml } from "./util";

// The languages agents write most; each brings its aliases (ts, sh, html, yml, …).
const languages = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, php, python, ruby, rust, scss, shell, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);

// html: false escapes any raw HTML in model output, and markdown-it refuses
// javascript:/vbscript: links on its own, so the result is safe to inject.
const md = markdownit({ html: false, linkify: true, breaks: false });
// Only link URLs that say so (https://…, www.…). Guessing would turn README.md into http://README.md.
md.linkify.set({ fuzzyLink: false });

/** Path-like strings the extension host found on disk, passed in the render env. */
function linksOf(env: unknown): Set<string> {
  const links = env ? (env as { links?: Set<string> }).links : undefined;
  return links || new Set<string>();
}

/** "src/a.ts:42", "src/a.ts:42:7", "src/a.ts#L42-L50" → path and line. */
function parseRef(ref: string): { path: string; line?: string } {
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(ref.trim());
  if (!m) return { path: ref };
  return { path: m[1], line: m[2] || m[3] };
}

function fileLinkAttrs(ref: { path: string; line?: string }): Array<[string, string]> {
  const attrs: Array<[string, string]> = [
    ["class", "file-link"],
    ["data-action", "openFile"],
    ["data-path", ref.path],
    ["title", `Open ${ref.path}${ref.line ? `:${ref.line}` : ""}${isHtml(ref.path) ? " (⌘-click: Relay's browser)" : ""}`],
  ];
  if (ref.line) attrs.push(["data-line", ref.line]);
  if (isHtml(ref.path)) attrs.push(["data-vscode-context", htmlLinkContext(ref.path)]);
  return attrs;
}

/**
 * The chat is rendered again on every streamed token, so each block is
 * highlighted once and kept. Only a named language is highlighted; guessing is
 * slow and often wrong.
 */
const highlighted = new Map<string, string>();

function highlight(code: string, lang: string): string {
  if (!lang || !hljs.getLanguage(lang)) return esc(code);
  const key = `${lang}\0${code}`;
  let html = highlighted.get(key);
  if (html === undefined) {
    // highlight.js escapes the code itself.
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (highlighted.size > 200) highlighted.clear();
    highlighted.set(key, html);
  }
  return html;
}

/** Whether a fence has its closing line yet; one still streaming in runs to the end of the text. */
function isClosed(token: Token, env: unknown): boolean {
  const text = env ? (env as { text?: string }).text : undefined;
  if (!text || !token.map) return false;
  const [start, end] = token.map;
  const last = text.split("\n")[end - 1];
  return end - 1 > start && last !== undefined && last.replace(/^[\s>]*/, "").startsWith(token.markup);
}

/**
 * Fenced code gets a header with its language and a copy button. A finished
 * mermaid block shows as its diagram, with a button to see the source.
 */
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0];
  const head = (extra = "") =>
    `<div class="code-head"><span>${esc(lang || "text")}</span><span class="grow"></span>${extra}<button class="code-copy" data-action="copyCode" title="Copy code">Copy</button></div>`;
  if (lang.toLowerCase() === "mermaid" && isClosed(token, env)) {
    const source = token.content;
    const img = isShowingSource(source) ? undefined : diagram(source);
    if (img) {
      return `<div class="code-block" data-mermaid>
    ${head(`<button class="code-copy" data-action="toggleDiagram" title="Show the source">Source</button>`)}
    <div class="mermaid-diagram">${img}</div>
    <pre hidden><code>${esc(source)}</code></pre>
  </div>`;
    }
    const toggle = isShowingSource(source) ? `<button class="code-copy" data-action="toggleDiagram" title="Show the diagram">Diagram</button>` : "";
    return `<div class="code-block" data-mermaid>
    ${head(toggle)}
    <pre><code>${esc(source)}</code></pre>
  </div>`;
  }
  return `<div class="code-block">
    ${head()}
    <pre><code>${highlight(token.content, lang.toLowerCase())}</code></pre>
  </div>`;
};

/** `src/a.ts:42` in backticks opens the file when it exists. */
md.renderer.rules.code_inline = (tokens, idx, _options, env) => {
  const content = tokens[idx].content;
  const ref = parseRef(content);
  if (!linksOf(env).has(ref.path)) return `<code>${esc(content)}</code>`;
  const attrs = fileLinkAttrs(ref)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(" ");
  return `<a ${attrs}><code>${esc(content)}</code></a>`;
};

/** [text](src/a.ts#L42): a link without a scheme points into the project, so open it in the editor. */
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  const raw = token.attrGet("href");
  const href = raw === null ? "" : String(raw);
  if (href && !/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith("#")) {
    let decoded = href;
    try {
      decoded = decodeURI(href);
    } catch {
      // Keep the raw href if it isn't valid percent-encoding.
    }
    token.attrs = fileLinkAttrs(parseRef(decoded));
  }
  return self.renderToken(tokens, idx, options);
};

let cachedKey = "";
let cachedPattern: RegExp | undefined;

/** Matches any known path as a whole word, with an optional :line suffix. */
function pathPattern(links: Set<string>): RegExp {
  const key = [...links].join("\n");
  if (key !== cachedKey || !cachedPattern) {
    const alternatives = [...links]
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    cachedPattern = new RegExp(`(?<![\\w@./-])(${alternatives})(?::(\\d+)(?::\\d+)?)?(?![\\w@/-])`, "g");
    cachedKey = key;
  }
  cachedPattern.lastIndex = 0;
  return cachedPattern;
}

/** Plain-text mentions of known paths ("Edited src/a.ts") become file links. */
md.core.ruler.push("file_links", (state: StateCore) => {
  const links = linksOf(state.env);
  if (!links.size) return;
  const pattern = pathPattern(links);
  const text = (content: string) => {
    const t = new state.Token("text", "", 0);
    t.content = content;
    return t;
  };
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Token[] = [];
    let insideLink = 0;
    for (const tok of block.children) {
      if (tok.type === "link_open") insideLink++;
      if (tok.type === "link_close") insideLink--;
      if (tok.type !== "text" || insideLink) {
        out.push(tok);
        continue;
      }
      let last = 0;
      pattern.lastIndex = 0;
      for (let m = pattern.exec(tok.content); m; m = pattern.exec(tok.content)) {
        if (m.index > last) out.push(text(tok.content.slice(last, m.index)));
        const open = new state.Token("link_open", "a", 1);
        open.attrs = fileLinkAttrs({ path: m[1], line: m[2] });
        out.push(open, text(m[0]), new state.Token("link_close", "a", -1));
        last = m.index + m[0].length;
      }
      if (last === 0) out.push(tok);
      else if (last < tok.content.length) out.push(text(tok.content.slice(last)));
    }
    block.children = out;
  }
});

export function renderMarkdown(text: string, links: Set<string> = new Set()): string {
  return md.render(text, { links, text });
}
