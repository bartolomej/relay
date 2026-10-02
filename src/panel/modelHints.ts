import * as vscode from "vscode";
import type { Difficulty, ModelSuggestion, ProviderInfo } from "../api/types";
import { checkKey, JevError, rateDifficulty } from "../backend/jev";

/**
 * Model suggestions: Jev rates how hard the message being typed looks, and
 * `relay.modelHintModels` says which model and effort each difficulty gets.
 * The TypeSafe API key is kept in the system keychain.
 */

const SECRET = "relay.jevApiKey";
const KEYS_URL = "https://console.typesafe.ai/keys";

let secrets: vscode.SecretStorage | undefined;
/** A rejected key is reported once, not on every pause in typing. */
let warnedBadKey = false;

type Tiers = Record<string, Partial<Record<Difficulty, { model?: string; effort?: string }>>>;

export function initModelHints(storage: vscode.SecretStorage): void {
  secrets = storage;
}

export function modelHintsEnabled(): boolean {
  return vscode.workspace.getConfiguration("relay").get<boolean>("modelHints", false);
}

/** Turning suggestions on asks for the key first if there isn't one; without one they stay off. */
export async function setModelHints(on: boolean): Promise<void> {
  if (on && !(await storedKey()) && !(await askForKey())) return;
  await vscode.workspace.getConfiguration("relay").update("modelHints", on, vscode.ConfigurationTarget.Global);
}

/** Asks for the key, checks it with TypeSafe and saves it. Undefined when cancelled or rejected. */
export async function askForKey(): Promise<string | undefined> {
  const pick = await vscode.window.showInputBox({
    title: "Jev API key",
    prompt: `Paste your TypeSafe API key. Relay sends each message you type to Jev to suggest a model. Create a key at ${KEYS_URL}`,
    password: true,
    ignoreFocusOut: true,
  });
  const key = pick ? pick.trim() : "";
  if (!key) return undefined;
  let ok: boolean;
  try {
    ok = await checkKey(key);
  } catch (err) {
    void vscode.window.showErrorMessage(`Couldn't check the Jev API key: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!ok) {
    void vscode.window.showErrorMessage("TypeSafe rejected that API key.");
    return undefined;
  }
  if (!secrets) return undefined;
  await secrets.store(SECRET, key);
  warnedBadKey = false;
  return key;
}

/** The model and effort for the text in this provider, or undefined when Jev or the settings can't say. */
export async function suggestModel(text: string, provider: ProviderInfo): Promise<ModelSuggestion | undefined> {
  const key = await storedKey();
  if (!key) return undefined;
  let difficulty: Difficulty;
  try {
    difficulty = await rateDifficulty(key, text);
  } catch (err) {
    if (err instanceof JevError && err.status === 401 && !warnedBadKey) {
      warnedBadKey = true;
      void vscode.window.showWarningMessage("Jev rejected the API key, so Relay can't suggest models.", "Set Key").then((pick) => {
        if (pick) void askForKey();
      });
    }
    return undefined;
  }
  const tiers = vscode.workspace.getConfiguration("relay").get<Tiers>("modelHintModels", {});
  const tier = tiers[provider.id] && tiers[provider.id][difficulty];
  const model = tier && provider.models.find((m) => m.id === tier.model);
  if (!tier || !model) return undefined;
  const effort = tier.effort && model.efforts.includes(tier.effort) ? tier.effort : model.defaultEffort || model.efforts[0] || "";
  return { difficulty, model: model.id, effort };
}

async function storedKey(): Promise<string | undefined> {
  return secrets ? secrets.get(SECRET) : undefined;
}
