import * as vscode from "vscode";
import type { NewSessionDefaults, SettingKey, SettingsView } from "./protocol";
import { hasJevKey, modelHintsEnabled } from "./modelHints";

/**
 * The settings screen reads and writes VS Code's `relay.*` settings, so
 * settings.json and VS Code's Settings editor stay the one place they live.
 */

type Kind = "boolean" | "string" | "object";

/** What each editable setting takes; enums list their values. Anything else from the webview is dropped. */
const EDITABLE: Record<SettingKey, Kind | string[]> = {
  modelHintModels: "object",
  newSessionModel: "object",
  newSessionWorktree: "boolean",
  newSessionBrowser: "boolean",
  notifications: ["all", "inApp", "off"],
  keepAwake: "boolean",
  planPrompt: "string",
  askPrompt: "string",
  titleModel: "string",
  claudePath: "string",
  codexPath: "string",
  chromePath: "string",
  tailscalePath: "string",
  backend: ["real", "mock"],
};

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("relay");
}

export async function settingsView(): Promise<SettingsView> {
  const c = config();
  return {
    modelHints: modelHintsEnabled(),
    jevKey: await hasJevKey(),
    modelHintModels: c.get("modelHintModels", {}),
    newSessionModel: c.get("newSessionModel", {}),
    newSessionWorktree: c.get("newSessionWorktree", false),
    newSessionBrowser: c.get("newSessionBrowser", false),
    notifications: c.get("notifications", "all"),
    keepAwake: c.get("keepAwake", true),
    planPrompt: c.get("planPrompt", ""),
    askPrompt: c.get("askPrompt", ""),
    titleModel: c.get("titleModel", ""),
    claudePath: c.get("claudePath", ""),
    codexPath: c.get("codexPath", ""),
    chromePath: c.get("chromePath", ""),
    tailscalePath: c.get("tailscalePath", ""),
    backend: c.get("backend", "real"),
  };
}

export function newSessionDefaults(): NewSessionDefaults {
  const c = config();
  return {
    options: c.get("newSessionModel", {}),
    worktree: c.get("newSessionWorktree", false),
    browser: c.get("newSessionBrowser", false),
  };
}

/**
 * Saves a value from the settings screen where the setting is defined now, so
 * a project's own value isn't hidden under a new user one. A value equal to
 * the default is removed instead, keeping settings.json short.
 */
export async function updateSetting(key: SettingKey, value: unknown): Promise<void> {
  const kind = EDITABLE[key];
  if (!kind) return;
  if (Array.isArray(kind) ? !kind.includes(value as string) : kind === "object" ? !isPlainObject(value) : typeof value !== kind) return;
  const c = config();
  const where = c.inspect(key);
  const target = where && where.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const isDefault = where !== undefined && JSON.stringify(where.defaultValue) === JSON.stringify(value);
  await c.update(key, isDefault ? undefined : value, target);
}

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
