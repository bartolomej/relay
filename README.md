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

![The sidebar: status at the top, then sessions grouped by state](img/sidebar%20ui.png)

- **Working**: running (spinner) or waiting for your approval (amber, with Allow, Deny and "Always for this session" right on the card).
- **Ready to review**: finished since you last looked, marked with a dot. It stays here while you read it and moves to **Past** when you click away.
- **Past**: sessions you've seen from the last 2 hours. **Show all past sessions** reveals older and completed ones.

**Complete** (top right of the chat, or the check on a card) archives a session when you're done with it. Sending it another message brings it back.

**Fork** any session, either from its latest message or from any earlier message in the chat. Forks nest under their parent, and a family of sessions moves between groups together. Each session gets a short title, rewritten after every message by a small Codex model, and hovering a card shows the full title.

**Second opinion.** The speech-bubble button in the chat header opens a subsession with the other provider (Codex for a Claude session, Claude for a Codex one) and drafts a review request in the message box: what the agent was asked, what it said at the end, the files it changed, and where to find the diff. The other provider can't read the conversation, so that's all it gets. Edit the draft if you like and press ↵ to send it. The subsession works in the same folder or worktree and nests under the session it reviews. The button shows once the session has replied and isn't working.

Relay works in the sidebar, or in an editor tab with two columns (**Relay: Open as Editor Tab**, or the icon in the view title).

### Plan usage and context

The **Status** panel at the top of the list shows every limit each provider reports, with percent used and time until reset:

- **Claude:** the 5-hour session, the weekly limit for all models, weekly limits per model (such as Fable or Sonnet), and extra usage.
- **Codex:** 5-hour and weekly limits, extra metered buckets, credits, and available limit resets.

Bars turn amber at 75% and red at 90%. It starts collapsed to one line showing each provider's fullest window; click it to expand. The chat header shows how full the open session's context window is.

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

When the approval is for a file change, the card shows the diff: added lines in green, removed in red, each file under its path.

### Questions

When an agent asks multiple-choice questions (Claude's `AskUserQuestion`, Codex's `request_user_input`), they appear as a card in the chat with each option as a button. Click to pick (questions marked "pick any" take several), or type your own answer under the options. A single question is answered by clicking an option; with several, **Send answers** sends them once each has one. **Answer in a message** has the agent ask in plain text instead. The session waits under **Working** and the card says "Has a question", with the same notifications as an approval.

### Getting your attention

When a session you aren't looking at finishes, fails, or stops for an approval or a question:

- the Relay icon in the activity bar shows a count of sessions to review or approve,
- a VS Code notification appears with an **Open** button,
- and, if VS Code isn't the focused app, a macOS notification plays a sound.

Nothing fires for the session you have open, or between queued turns.

### Long runs

- **Run timer and time limit.** The chat header shows how long the current run has been going. Click the timer to set a limit (e.g. `30m` or `1h30m`); the agent is stopped when it's reached.
- **Keep awake.** While an agent is working, Relay keeps your Mac from idle-sleeping (the display can still sleep). Toggle it with the cup icon in the chat header.
- **Worktrees.** Before starting a new session, click the branch icon in the chat header to have the agent work in its own git worktree (in `~/.relay/worktrees`, on a `relay/…` branch, with `node_modules` linked from the project). Your project folder stays untouched while it works. **Complete** commits what's left, merges the branch into the one you started from with a merge commit, and removes the worktree. If your branch has moved on and conflicts, the agent is asked to resolve them first. Off by default.

### Notes from the browser

Click the globe next to **New** in the editor tab, or in Relay's title bar in the sidebar (or run **Relay: Open in Browser**), and enter your app's address, e.g. `localhost:3000`. Relay opens its own Chrome window, with a profile of its own for each project. On any page, click the ✎ button in the bottom-right corner (or press ⌥⇧C), click an element, and write what should change. The popup's dropdown picks the chat, defaulting to the one open in Relay. The note is added to that chat's message box with the page address, a CSS selector for the element, and the element's text, so you can review it or collect several before sending. While you pick, the app doesn't see your clicks. Pages can't see or send notes themselves, because the picker runs apart from their scripts.

### Scheduled tasks

Click the calendar next to the globe in the editor tab, or in Relay's title bar in the sidebar (or run **Relay: Scheduled Tasks**), to see the project's scheduled tasks. Click it again to go back to the sessions. A task is a prompt that starts a new session on a schedule: **daily**, on **weekdays**, **weekly** on a chosen day, or **monthly** on a chosen date (a month without that date runs on its last day), always at a set time. Each task also picks its provider, model and effort, and a time limit per run (1 hour by default).

- **One prompt per run.** Each run is a new session that gets the prompt as its only message and starts with no memory of earlier runs, so the prompt has to say everything the agent needs to know.
- **Try it out.** **Save and run now** starts a run straight away and opens it. Adjust the prompt and run it again until the result is right, then leave it to the schedule.
- **From a session.** The calendar in a chat's header opens a new task with that session's messages, oldest first, as the prompt. Trim them into one self-contained request.
- **Runs are sessions.** They show up in the list like any other session with a **Scheduled** tag, notify you when they finish, and are listed under **Runs** in the task. The tag in a run's header opens its task.
- **Worktree by default.** In a git project, each run works in its own worktree (see **Worktrees** above), so your project folder stays untouched. **Complete** merges a run's work back.
- **Only while VS Code is open.** Tasks run while this project is open in VS Code; opening a project that has scheduled tasks starts Relay by itself. A run that was due while VS Code was closed or the Mac slept starts once when it's back, however many were missed. A run is skipped if the task's previous run is still working, including one waiting for an approval.

Tasks are saved in `.relay/schedules.json` in the project. They aren't shown on the phone.

### Remote access from your phone

Click the phone icon next to **New** in the editor tab, or in Relay's title bar in the sidebar (or run **Relay: Turn On Remote Access**), to check on sessions, read their output, send prompts, answer approvals and stop agents from your phone, from anywhere. A QR code opens; scan it with the phone's camera. Click the icon again to turn it off. It's off by default and after every reload, and it turns itself off after 24 hours, or as soon as you use the Mac again after 10 minutes away (or after it slept).

It goes through [Tailscale](https://tailscale.com), a private network between your own devices: install it on the Mac and the phone and sign in with the same account. Tailscale on the Mac is only connected while Remote is on: turning Remote on runs `tailscale up`, turning it off runs `tailscale down`, which disconnects the whole Mac from your tailnet. Relay's server listens only on the Mac itself, and Relay runs `tailscale serve` to reach it at `https://<your-mac>.<tailnet>.ts.net:8443` from your devices only. Nothing is exposed to the internet. The first time, Tailscale may ask you to enable HTTPS for your tailnet; the QR page shows its link.

- **Access key.** Every request also needs the project's access key, which is in the QR code (after `#`, so it never reaches a server log). It's made once per project, kept in the macOS Keychain, and reused. **Relay: Reset Remote Access Key** makes a new one and signs out every phone.
- **Only reading on the phone doesn't count as reviewed.** Sessions stay under Ready to review until you open them on the laptop or click **Complete**.
- **Keeps the Mac awake.** While Remote is on, the Mac stays awake until all agents are done, including ones waiting for an approval, whatever the keep-awake setting says. Closing the lid still puts it to sleep, and once it sleeps the phone can't reach it.
- **One project at a time.** Turning Remote on in another window moves it there.
- On the phone, return adds a new line and the send button sends. File names aren't links.

### Sessions live in your project

Each session is saved as a JSON file in `.relay/sessions/` inside the project, so every project shows only its own sessions and they survive reloads. If you rename or move the project folder, its sessions follow it. The files contain full transcripts, so consider adding `.relay/` to your `.gitignore` unless you want to share them.

## Requirements

- VS Code 1.137 or newer.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) installed and signed in. Relay finds them on your PATH, in `~/.local/bin`, or in Homebrew's folder. Otherwise, set their paths in the settings below.
- Remote access needs [Tailscale](https://tailscale.com) on the Mac and the phone.
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
| `relay.tailscalePath` | | Path to `tailscale`, if Relay can't find it on your PATH or in the Tailscale app. |
| `relay.backend` | `real` | `mock` runs fake providers with sample sessions, for working on the UI. |

## Known limitations

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
- **Scheduled tasks** are started by the [Scheduler](src/backend/scheduler.ts), which checks every 30 seconds and creates sessions through the same SessionsApi; [schedule.ts](src/api/schedule.ts) works out when each one comes up.
- **The UI** is a webview ([src/webview](src/webview)) fed full state snapshots by [PanelHost](src/panel/PanelHost.ts).

```
src/
  extension.ts            activation, commands, notifications, wiring
  api/                    shared types, the SessionsApi interface, the mock
  backend/                session rules, Claude and Codex adapters, .relay store, scheduler
  panel/                  webview hosts (sidebar, editor tab), protocol, file links, attention
  webview/                sessions list, chat, composer, scheduled tasks, markdown, styles
```
