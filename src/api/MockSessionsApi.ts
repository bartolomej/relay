import type { ProviderAdapter, TurnResult, TurnSink, TurnTarget } from "../backend/adapter";
import { RealSessionsApi } from "../backend/RealSessionsApi";
import { SessionStore } from "../backend/store";
import type { SessionsApi } from "./SessionsApi";
import type { InspectContext, InspectSetup, Message, ProviderId, ProviderInfo, ProviderUsage, Session, SessionInspect } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

const CATALOGUE: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: "claude",
    label: "Claude",
    models: [
      { id: "opus", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
      { id: "sonnet", label: "Sonnet 5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
      { id: "haiku", label: "Haiku 4.5", efforts: [] },
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5.5", label: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "gpt-5.5-mini", label: "gpt-5.5-mini", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
  },
};

const REPLY =
  "Looking at how sections are declared in the schema. The nested validator needs to walk each section recursively and collect unknown keys with their full path, so the error message points at the exact location.";

const MOCK_SETUP: InspectSetup = {
  model: "claude-opus-5-5",
  version: "2.1.284",
  permissionMode: "auto",
  outputStyle: "default",
  tools: ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"],
  mcpServers: [
    { name: "relay_browser", status: "connected" },
    { name: "linear", status: "needs-auth" },
  ],
  skills: ["dataviz", "code-review"],
  agents: ["general-purpose", "Explore", "Plan"],
  plugins: ["feature-dev 1.2.0"],
};

function mockContext(used: number): InspectContext {
  const fixed = 3_100 + 11_800 + 2_400 + 1_900 + 900;
  return {
    usedTokens: used,
    limitTokens: 200_000,
    autoCompactAt: 167_000,
    categories: [
      { name: "System prompt", tokens: 3_100, kind: "used" },
      { name: "System tools", tokens: 11_800, kind: "used" },
      { name: "MCP tools", tokens: 2_400, kind: "used" },
      { name: "Memory files", tokens: 1_900, kind: "used" },
      { name: "Skills", tokens: 900, kind: "used" },
      { name: "Messages", tokens: Math.max(0, used - fixed), kind: "used" },
      { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
      { name: "Free space", tokens: Math.max(0, 200_000 - used - 33_000), kind: "free" },
    ],
    memoryFiles: [
      { path: "~/.claude/CLAUDE.md", type: "User", tokens: 1_200 },
      { path: "CLAUDE.md", type: "Project", tokens: 700 },
    ],
    skills: [
      { name: "dataviz", source: "bundled", tokens: 520 },
      { name: "code-review", source: "bundled", tokens: 380 },
    ],
    agents: [{ name: "Explore", source: "built-in", tokens: 240 }],
    mcpTools: [
      { name: "click", server: "relay_browser", tokens: 310 },
      { name: "navigate_page", server: "relay_browser", tokens: 420 },
      { name: "take_snapshot", server: "relay_browser", tokens: 1_670 },
    ],
    toolTokens: [
      { name: "Read", tokens: 14_300 },
      { name: "Bash", tokens: 3_900 },
      { name: "Grep", tokens: 1_100 },
    ],
  };
}

/** A finished turn with a read, a subagent search and a test run, as the Claude adapter reports it. */
function mockInspect(now: number): SessionInspect {
  const at = (s: number) => now - 2 * MIN + s * 1000;
  return {
    setup: MOCK_SETUP,
    context: mockContext(41_000),
    stats: {
      turns: 1,
      roundTrips: 6,
      durationMs: 74_000,
      apiDurationMs: 51_000,
      costUsd: 0.84,
      models: [
        { model: "claude-opus-5-5", input: 2_100, output: 3_400, cacheRead: 162_000, cacheWrite: 21_000, costUsd: 0.79 },
        { model: "claude-haiku-4-5-20251001", input: 9_800, output: 600, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 },
      ],
    },
    tools: [
      { id: "t1", name: "Read", kind: "read", label: "Read", target: "src/config.ts", path: `src/config.ts`, startedAt: at(4), endedAt: at(4.2), ok: true, resultTokens: 2_900 },
      { id: "ta", name: "Agent", kind: "other", label: "Delegated", target: "Find callers of parseConfig", startedAt: at(9), endedAt: at(31), ok: true, resultTokens: 420 },
      { id: "ta1", name: "Grep", kind: "read", label: "Searched", target: "parseConfig", agent: "Find callers of parseConfig", startedAt: at(11), endedAt: at(11.6), ok: true, resultTokens: 180 },
      { id: "ta2", name: "Read", kind: "read", label: "Read", target: "src/env.ts", path: "src/env.ts", agent: "Find callers of parseConfig", startedAt: at(14), endedAt: at(14.1), ok: true, resultTokens: 1_300 },
      { id: "t2", name: "Edit", kind: "edit", label: "Edited", target: "src/config.ts", path: "src/config.ts", startedAt: at(38), endedAt: at(38.3), ok: true, resultTokens: 90 },
      { id: "t3", name: "Bash", kind: "run", label: "Ran", target: "npm test", startedAt: at(44), endedAt: at(63), ok: true, resultTokens: 1_850 },
    ],
    events: [
      { at: at(0), kind: "turn", text: "Sent: Implement parseConfig() in src/config.ts. Unknown keys should throw, not warn." },
      { at: at(0.5), kind: "hook", text: "Hook UserPromptSubmit:lint-prompt: success", detail: "Prompt mentions a file that doesn't exist: src/configs.ts" },
      { at: at(31), kind: "subagent", text: "Find callers of parseConfig completed: 2 tool calls, 11,420 tokens, 22s" },
      { at: at(40), kind: "retry", text: "API retry 1 of 10 after HTTP 529, waiting 1.2s" },
      { at: at(74), kind: "turn", text: "Turn done: 6 requests in 1m 14s" },
    ],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A pretend provider: streams a canned reply a couple of words at a time,
 * asks for approval when the prompt mentions a migration, and asks
 * multiple-choice questions when it says "choose" or "pick". It runs through the
 * same RealSessionsApi as Claude and Codex, so the UI rules are exercised for real.
 */
class MockAdapter implements ProviderAdapter {
  private stopped = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    readonly id: ProviderId,
    private readonly plan: ProviderUsage,
  ) {}

  async info(): Promise<ProviderInfo> {
    return CATALOGUE[this.id];
  }

  async usage(): Promise<ProviderUsage> {
    return { ...this.plan, windows: this.plan.windows.map((w) => ({ ...w })), updatedAt: Date.now() };
  }

  async runTurn(target: TurnTarget, text: string, sink: TurnSink): Promise<TurnResult> {
    this.stopped.delete(target.sessionId);
    const stopped = () => this.stopped.has(target.sessionId);
    sink.providerSessionId(target.providerSessionId || `mock-${target.sessionId}`);
    const claude = this.id === "claude";
    if (claude) {
      sink.inspect({ setup: MOCK_SETUP });
      sink.inspect({ event: { at: Date.now(), kind: "turn", text: `Sent: ${text.split("\n")[0]}` } });
      const id = `read-${Date.now()}`;
      sink.inspect({ tool: { id, name: "Read", kind: "read", label: "Read", target: "README.md", path: "README.md", startedAt: Date.now() } });
      sink.tool({ id, kind: "read", label: "Read", target: "README.md", path: "README.md" });
      await sleep(300);
      sink.inspect({ tool: { id, endedAt: Date.now(), ok: true, resultTokens: 2_400 } });
      sink.tool({ id, ok: true, kind: "read", label: "Read", target: "README.md", path: "README.md" });
    }
    if (/migrat/i.test(text)) {
      const decision = await sink.approval({ kind: "bash", summary: "wants to run a command", detail: "npm run db:migrate -- --to latest" });
      if (stopped()) return { ok: true };
      if (decision === "deny") {
        sink.text("Understood, skipping that command.");
        return { ok: true };
      }
      sink.tool({ id: `run-${Date.now()}`, kind: "run", label: "Ran", target: "npm run db:migrate -- --to latest", detail: "exit 0", ok: true });
    }
    if (/\b(choose|pick)\b/i.test(text)) {
      const answers = await sink.questions([
        {
          id: "library",
          header: "Library",
          question: "Which library should parse the dates?",
          options: [
            { label: "date-fns", description: "Small, tree-shakeable functions" },
            { label: "Temporal", description: "The built-in API, with a polyfill for now" },
          ],
        },
        {
          id: "formats",
          header: "Formats",
          question: "Which formats should be accepted?",
          options: [{ label: "ISO 8601" }, { label: "RFC 2822" }, { label: "Unix seconds" }],
          multiSelect: true,
        },
      ]);
      if (stopped()) return { ok: true };
      sink.text(answers ? `Going with ${Object.values(answers).map((a) => a.join(" and ")).join(", accepting ")}.` : "Sure, tell me in a message.");
      return { ok: true };
    }
    const words = REPLY.split(" ");
    let used = 30_000 + text.length * 4;
    for (let i = 0; i < words.length; i += 2) {
      await sleep(220 + Math.random() * 180);
      if (stopped()) return { ok: true };
      sink.text((i ? " " : "") + words.slice(i, i + 2).join(" "));
      used += 450;
      sink.context({ usedTokens: used, limitTokens: this.id === "claude" ? 200_000 : 272_000 });
      sink.tokens({ input: used, cachedInput: used - 450, output: 60 });
      for (const w of this.plan.windows) if (w.resetsAt) w.usedPercent = Math.min(100, w.usedPercent + 0.02);
    }
    sink.checkpoint(`mock-msg-${Date.now()}`);
    if (claude) {
      sink.inspect({ turn: { roundTrips: 2, durationMs: 9_000, apiDurationMs: 7_500, costUsd: 0.12, models: [] } });
      sink.inspect({ event: { at: Date.now(), kind: "turn", text: "Turn done: 2 requests in 9.0s" } });
      sink.inspect({ context: mockContext(used) });
    }
    return { ok: true };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.stopped.add(sessionId);
  }

  onDidChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** The whole UI against fake providers, seeded with sessions in every group. */
export function createMockSessionsApi(cwd: string): SessionsApi {
  const now = Date.now();
  const store = new SessionStore();
  seed(store, cwd, now);
  const api = new RealSessionsApi(store, [
    new MockAdapter("claude", {
      provider: "claude",
      plan: "Max",
      updatedAt: now,
      windows: [
        // Claude Code's /usage rows.
        { id: "session", label: "Session (5h)", usedPercent: 42, resetsAt: now + 2 * HOUR + 10 * MIN },
        { id: "weekly_all", label: "Week · all models", usedPercent: 18, resetsAt: now + 3 * 24 * HOUR + 5 * HOUR },
        { id: "weekly_fable", label: "Week · Fable", usedPercent: 31, resetsAt: now + 3 * 24 * HOUR + 5 * HOUR },
        { id: "extra_usage", label: "Extra usage", usedPercent: 25, detail: "$12.40 of $50 this month" },
      ],
    }),
    new MockAdapter("codex", {
      provider: "codex",
      plan: "Plus",
      updatedAt: now,
      windows: [
        // Codex's /status: primary and secondary windows, labelled by length, plus credits.
        { id: "primary", label: "5h limit", usedPercent: 12, resetsAt: now + 4 * HOUR + 20 * MIN },
        { id: "secondary", label: "Weekly limit", usedPercent: 78, resetsAt: now + 4 * 24 * HOUR },
      ],
      extras: [{ label: "Credits", value: "140 left" }],
    }),
  ]);
  // Put three sessions mid-turn: two streaming, one stopped at an approval.
  void api.sendMessage("s-parse", "Good. Now handle the nested sections validation you skipped.");
  void api.sendMessage("s-loadenv", "Keep going with loadEnv.");
  void api.sendMessage("s-migrate", "Run the migration to check it applies cleanly.");
  return api;
}

function seed(store: SessionStore, cwd: string, now: number): void {
  const folder = cwd.split("/").pop() || cwd;
  const base = (id: string, provider: Session["options"]["provider"], model: string) => ({
    id,
    options: { provider, model, effort: "medium" as const },
    cwd,
    folder,
    unread: false,
    archived: false,
    queued: [],
    providerSessionId: `mock-${id}`,
    transcriptPath: "",
  });
  const put = (s: Session, msgs: Message[]) => {
    // Roughly: system prompt and tools, plus a few thousand tokens per turn.
    s.context = { usedTokens: 14_000 + msgs.length * 9_000, limitTokens: s.options.provider === "claude" ? 200_000 : 272_000 };
    // Each turn re-reads the context a few times over, mostly from cache.
    s.tokens = { input: msgs.length * 61_000, cachedInput: msgs.length * 54_000, output: msgs.length * 1_450 };
    store.put(s, msgs);
    return s;
  };

  // Working once bootstrapped: a streaming session with a streaming fork, and one at an approval.
  const parse = put(
    {
      ...base("s-parse", "claude", "opus"),
      title: "Refactor parseConfig to throw on unknown keys",
      status: "done",
      createdAt: now - 2 * MIN - 14_000,
      lastActivityAt: now,
    },
    [
      { id: "m-p1", role: "user", text: "Implement parseConfig() in src/config.ts. Unknown keys should throw, not warn.", createdAt: now - 2 * MIN },
      {
        id: "m-p2",
        role: "assistant",
        text: "I'll add a strict parser. Reading the current file first.",
        createdAt: now - 2 * MIN + 5000,
        tools: [
          { id: "t1", kind: "read", label: "Read", target: "src/config.ts", path: "src/config.ts" },
          { id: "t2", kind: "edit", label: "Edited", target: "src/config.ts", added: 42, removed: 3 },
          { id: "t3", kind: "run", label: "Ran", target: "npm test", detail: "12 passed", ok: true },
        ],
      },
      {
        id: "m-p3",
        role: "assistant",
        text: "Done. parseConfig now throws ConfigError listing every unknown key, and the tests cover nested sections.",
        createdAt: now - MIN - 20_000,
      },
    ],
  );
  store.inspects.set(parse.id, mockInspect(now));

  put(
    {
      ...base("s-loadenv", "codex", "gpt-5.5"),
      title: "Change loadEnv to use parseConfig",
      status: "done",
      createdAt: now - 41_000,
      lastActivityAt: now,
      parentId: parse.id,
      forkedFromMessageId: "m-p3",
      forkedFromIndex: 3,
    },
    [
      { id: "m-l1", role: "user", text: "Now also make loadEnv() go through parseConfig so both paths validate the same way.", createdAt: now - 41_000 },
      {
        id: "m-l2",
        role: "assistant",
        text: "Reading loadEnv and its callers.",
        createdAt: now - 35_000,
        tools: [
          { id: "t4", kind: "read", label: "Read", target: "src/env.ts" },
          { id: "t5", kind: "read", label: "Read", target: "src/index.ts" },
        ],
      },
    ],
  );

  put(
    {
      ...base("s-migrate", "codex", "gpt-5.5"),
      title: "Migrate rollouts to sqlite",
      status: "done",
      createdAt: now - 6 * MIN,
      lastActivityAt: now - 40_000,
    },
    [
      { id: "m-g1", role: "user", text: "Move rollout state from the JSON file into sqlite.", createdAt: now - 6 * MIN },
      {
        id: "m-g2",
        role: "assistant",
        text: "Schema and migration are written.",
        createdAt: now - 40_000,
        tools: [{ id: "t6", kind: "write", label: "Wrote", target: "migrations/004_rollouts.sql", added: 31, removed: 0 }],
      },
    ],
  );

  // Ready to review: finished, not opened yet. One has a fork that was already read.
  const mock = put(
    {
      ...base("s-mock", "claude", "sonnet"),
      title: "Session panel mock in HTML",
      status: "done",
      unread: true,
      createdAt: now - 25 * MIN,
      lastActivityAt: now - 4 * MIN,
    },
    [
      { id: "m-m1", role: "user", text: "Make a simple mock of the sessions panel in HTML and CSS.", createdAt: now - 25 * MIN },
      { id: "m-m2", role: "assistant", text: "Two artboards: the sidebar with chat, and the sidebar with past sessions expanded.", createdAt: now - 4 * MIN },
    ],
  );
  put(
    {
      ...base("s-mock-grid", "claude", "sonnet"),
      title: "Try alternative with grid layout",
      status: "done",
      createdAt: now - 9 * MIN,
      lastActivityAt: now - 6 * MIN,
      parentId: mock.id,
      forkedFromMessageId: "m-m2",
      forkedFromIndex: 2,
    },
    [
      { id: "m-mg1", role: "user", text: "Same thing but with a CSS grid instead of flex.", createdAt: now - 9 * MIN },
      { id: "m-mg2", role: "assistant", text: "Grid version done, it lines up the fork tree columns better.", createdAt: now - 6 * MIN },
    ],
  );
  put(
    {
      ...base("s-lint", "codex", "gpt-5.5-mini"),
      title: "Fix eslint warnings in webview",
      status: "failed",
      unread: true,
      createdAt: now - 18 * MIN,
      lastActivityAt: now - 11 * MIN,
    },
    [
      { id: "m-e1", role: "user", text: "Clear the eslint warnings under src/webview.", createdAt: now - 18 * MIN },
      { id: "m-e2", role: "assistant", text: "Stopped: eslint is not installed in this project, and I was told not to add dependencies.", createdAt: now - 11 * MIN },
    ],
  );

  // Past: opened, not completed. Two inside the 2 hour window, the rest older.
  const past: Array<[string, string, Session["options"]["provider"], number, Session["status"], boolean]> = [
    ["s-rtsp", "Fix RTSP camera timeout", "codex", 38, "done", false],
    ["s-readme", "Rewrite README intro", "claude", 95, "done", false],
    ["s-adr", "Write ADR for session storage", "claude", 50, "done", true],
    ["s-o1", "Plan: instagram comment feed", "claude", 3 * 60, "done", false],
    ["s-o2", "Replace Nacrt with Projektni Pogoji", "codex", 27 * 60, "done", false],
    ["s-o3", "Talk: agent0 architecture options", "claude", 2 * 24 * 60, "done", true],
    ["s-o4", "Lighthouse fixes for landing", "claude", 3 * 24 * 60, "failed", false],
  ];
  for (const [id, title, provider, minutesAgo, status, archived] of past) {
    put(
      {
        ...base(id, provider, provider === "claude" ? "sonnet" : "gpt-5.5"),
        title,
        status,
        archived,
        createdAt: now - minutesAgo * MIN - 10 * MIN,
        lastActivityAt: now - minutesAgo * MIN,
      },
      [
        { id: `${id}-u`, role: "user", text: title, createdAt: now - minutesAgo * MIN - 10 * MIN },
        { id: `${id}-a`, role: "assistant", text: status === "failed" ? "Stopped: the build failed before the audit could run." : "Done.", createdAt: now - minutesAgo * MIN },
      ],
    );
  }
}
