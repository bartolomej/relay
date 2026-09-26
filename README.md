# Relay

One VS Code panel for all your AI coding sessions. Run Claude and Codex side by side, see which sessions need you, and keep an eye on your plan limits without leaving the editor.

![Relay in an editor tab: plan usage and sessions on the left, a running Claude session on the right](img/whole%20extension.png)

Relay drives the `claude` and `codex` CLIs you already have installed, so your logins, settings, `CLAUDE.md` files and permission rules all apply.

## Features

### Claude and Codex in one place

Pick the provider, model and effort for each message from the composer. The model list comes live from each CLI (Claude Code's `/model` catalogue and Codex's `model/list`), so new models and effort levels appear as soon as your CLI knows about them. Nothing is hardcoded. Hover a model to see its description and exact id.

Switch the mode dropdown next to effort to **Plan** to have the agent read the code, outline its approach and ask numbered questions (with its recommended option for each) before writing any code. The instruction is added to your message behind the scenes; the chat shows what you typed with a Plan tag. It goes back to Normal after each send.

Switch it to **Ask** when you only want an answer. The agent can read and search the code but can't change anything: Claude gets only its read and search tools, and Codex runs in its read-only sandbox. Ask stays on until you switch back.

### Sessions sorted by what needs you

![The sidebar: usage at the top, then sessions grouped by state](img/sidebar%20ui.png)

- **Working**: running (spinner) or waiting for your approval (amber, with Allow, Deny and "Always for this session" right on the card).
- **Ready to review**: finished since you last looked, marked with a dot. It stays here while you read it and moves to **Past** when you click away.
- **Past**: sessions you've seen from the last 2 hours. **Show all past sessions** reveals older and completed ones.

**Complete** (top right of the chat, or the check on a card) archives a session when you're done with it. Sending it another message brings it back.

**Fork** any session, either from its latest message or from any earlier message in the chat. Forks nest under their parent, and a family of sessions moves between groups together. Each session gets a short title, rewritten after every message by a small Codex model, and hovering a card shows the full title.

Relay works in the sidebar, or in an editor tab with two columns (**Relay: Open as Editor Tab**, or the icon in the view title).

### Plan usage and context

The top of the list shows every limit each provider reports, with percent used and time until reset:

- **Claude:** the 5-hour session, the weekly limit for all models, weekly limits per model (such as Fable or Sonnet), and extra usage.
- **Codex:** 5-hour and weekly limits, extra metered buckets, credits, and available limit resets.

Bars turn amber at 75% and red at 90%. In the sidebar the panel collapses to one line showing each provider's fullest window. The chat header shows how full the open session's context window is.

### Sending messages

![The composer with a queued message and the stop button](img/input%20with%20queue.png)

| Key | What it does |
|---|---|
| **↵** | Send. While the agent is working, the message is **queued** and goes out when the current turn ends. |
| **⌘↵** (Ctrl+↵) | Interrupt the running turn and send right away. |
| **Esc** | Stop the agent. |
| **⇧↵** or **⌥↵** | New line. |

Queued messages wait above the composer, each with **send now** and **remove**. While the agent works, the send button turns into a stop button. The message box grows up to 10 lines before it scrolls.

### Readable replies

- Replies render as markdown: headings, lists, tables, and code blocks with a **Copy** button.
- **File names are links.** Clicking a path in a reply or a tool row opens the file in the editor, at the line when one is given (`src/app.ts:42`). Only files that actually exist are linked.
- Each tool call shows as a compact row: files read, commands run with their exit codes, files edited with `+added −removed` line counts.
- Your latest message stays pinned at the top of the chat while the reply scrolls under it. Click it to expand a long one.

### Approvals

Both agents run in their **auto** mode.

- **Claude** uses its auto permission mode. Whatever its classifier wants a person to confirm appears on the Allow / Deny card.
- **Codex** uses its Auto preset. It edits files and runs commands inside the project on its own, and asks only for network access or writes outside the project.

### Getting your attention

When a session you aren't looking at finishes, fails, or stops for an approval:

- the Relay icon in the activity bar shows a count of sessions to review or approve,
- a VS Code notification appears with an **Open** button,
- and, if VS Code isn't the focused app, a macOS notification plays a sound.

Nothing fires for the session you have open, or between queued turns.

### Long runs

- **Run timer and time limit.** The chat header shows how long the current run has been going. Click the timer to set a limit (e.g. `30m` or `1h30m`); the agent is stopped when it's reached.
- **Keep awake.** While an agent is working, Relay keeps your Mac from idle-sleeping (the display can still sleep). Toggle it with the cup icon in the chat header.
- **Worktrees.** Before starting a new session, click the branch icon in the chat header to have the agent work in its own git worktree (in `~/.relay/worktrees`, on a `relay/…` branch, with `node_modules` linked from the project). Your project folder stays untouched while it works. **Complete** commits what's left, merges the branch into the one you started from with a merge commit, and removes the worktree. If your branch has moved on and conflicts, the agent is asked to resolve them first. Off by default.

### Notes from the browser

Click the globe in Relay's title bar (or run **Relay: Open in Browser**) and enter your app's address, e.g. `localhost:3000`. Relay opens its own Chrome window, with a profile of its own for each project. On any page, click the ✎ button in the bottom-right corner (or press ⌥⇧C), click an element, and write what should change. The popup's dropdown picks the chat, defaulting to the one open in Relay. The note is added to that chat's message box with the page address, a CSS selector for the element, and the element's text, so you can review it or collect several before sending. While you pick, the app doesn't see your clicks. Pages can't see or send notes themselves, because the picker runs apart from their scripts.

### Sessions live in your project

Each session is saved as a JSON file in `.relay/sessions/` inside the project, so every project shows only its own sessions and they survive reloads. If you rename or move the project folder, its sessions follow it. The files contain full transcripts, so consider adding `.relay/` to your `.gitignore` unless you want to share them.

## Requirements

- VS Code 1.137 or newer.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) installed and signed in. Relay finds them on your PATH, in `~/.local/bin`, or in Homebrew's folder. Otherwise, set their paths in the settings below.
- Open in Browser needs Google Chrome, or set `relay.chromePath` to another Chromium browser (Edge, Brave and Chromium are found automatically on macOS).
- Plan usage needs a subscription sign-in (claude.ai for Claude, ChatGPT for Codex). With an API key, sessions still work but no limits are shown.

## Install

```
make install          # once: install dependencies
make install-extension
```

This builds `relay.vsix` and installs it into VS Code. Reload any open windows, then click the Relay icon in the activity bar. Run `make install-extension` again after pulling changes.

## Settings

| Setting | Default | |
|---|---|---|
| `relay.notifications` | `all` | `all`: VS Code notification plus a macOS one when VS Code isn't focused. `inApp`: VS Code only. `off`: badge only. |
| `relay.keepAwake` | `true` | Keep the Mac awake while an agent works. |
| `relay.planPrompt` | *(see Settings UI)* | Instruction added to the end of a message sent in Plan mode. |
| `relay.askPrompt` | *(see Settings UI)* | Instruction added to the end of a message sent in Ask mode. |
| `relay.titleModel` | `gpt-5.6-luna` | Codex model that writes session titles. Without Codex, the title is the message's first line. |
| `relay.claudePath` | | Path to `claude`, if Relay can't find it. |
| `relay.codexPath` | | Path to `codex`, if Relay can't find it. |
| `relay.chromePath` | | Path to the browser Open in Browser starts, if Relay can't find Chrome. |
| `relay.backend` | `real` | `mock` runs fake providers with sample sessions, for working on the UI. |

## Known limitations

- When an agent asks a multiple-choice question (Claude's `AskUserQuestion`), Relay declines it and the agent asks in plain text instead.
- Codex file-change approvals list the files but don't show the diff yet.
- Code blocks aren't syntax-highlighted.
- Clicking the macOS notification opens Script Editor, not VS Code. Use the in-app **Open** button.
- Sessions you start in the terminal with `claude` or `codex` aren't listed; only sessions started from Relay are.

## Development

```
make install   # once
make run       # build, then open an Extension Development Host on this folder
make watch     # rebuild on change; reload the dev host window with ⌘R
make package   # build relay.vsix without installing it
```

Set `relay.backend` to `mock` to work on the UI without spending plan usage.

How it fits together:

- **The session rules** (unread, complete, queue, interrupt, forks, time limits) live in [RealSessionsApi](src/backend/RealSessionsApi.ts). Each provider plugs in as a [ProviderAdapter](src/backend/adapter.ts).
- **[Claude](src/backend/claude.ts)** runs through the Agent SDK on your installed `claude`: one query per turn, resumed by session id.
- **[Codex](src/backend/codex.ts)** runs through one long-lived `codex app-server` process: each session is a Codex thread, and the adapter talks to it over JSON-RPC on stdio.
- **The mock** ([MockSessionsApi](src/api/MockSessionsApi.ts)) is the same core with fake adapters.
- **The UI** is a webview ([src/webview](src/webview)) fed full state snapshots by [PanelHost](src/panel/PanelHost.ts).

```
src/
  extension.ts            activation, commands, notifications, wiring
  api/                    shared types, the SessionsApi interface, the mock
  backend/                session rules, Claude and Codex adapters, .relay store
  panel/                  webview hosts (sidebar, editor tab), protocol, file links, attention
  webview/                sessions list, chat, composer, markdown, styles
```
