import * as vscode from "vscode";
import type { Difficulty, Effort, ModelInfo, ModelSuggestion, ModelTiers, ProviderInfo } from "../api/types";
import { checkKey, JevError, rateDifficulty } from "../backend/jev";

/**
 * Model suggestions: Jev rates how hard the message being typed looks, and
 * `relay.modelHintModels` says which model and effort each difficulty gets.
 * Once a session has started only the effort changes: switching model drops
 * the prompt cache and costs far more than the cheaper model saves, while
 * switching effort keeps it. The TypeSafe API key is kept in the system keychain.
 */

const SECRET = "relay.jevApiKey";
const KEYS_URL = "https://console.typesafe.ai/keys";

const LEVELS: Array<[Difficulty, string]> = [
  ["simple", "Simple"],
  ["standard", "Standard"],
  ["complex", "Complex"],
];

/** The effort each difficulty gets once the session's model is fixed. */
const SESSION_EFFORT: Record<Difficulty, Effort> = { simple: "low", standard: "medium", complex: "high", extreme: "xhigh" };
const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

let secrets: vscode.SecretStorage | undefined;
let listProviders: () => Promise<ProviderInfo[]> = () => Promise.resolve([]);
/** A rejected key is reported once, not on every pause in typing. */
let warnedBadKey = false;

const keyChanged = new vscode.EventEmitter<void>();
/** The key was saved; the settings screen shows whether there is one. */
export const onDidChangeJevKey = keyChanged.event;

/** Keeps the `relay.modelHints` context key in step, for the sidebar's toggle. */
export function initModelHints(context: vscode.ExtensionContext, providers: () => Promise<ProviderInfo[]>): void {
  secrets = context.secrets;
  listProviders = providers;
  const sync = () => void vscode.commands.executeCommand("setContext", "relay.modelHints", modelHintsEnabled());
  sync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("relay.modelHints")) sync();
    }),
  );
}

export function modelHintsEnabled(): boolean {
  return vscode.workspace.getConfiguration("relay").get<boolean>("modelHints", false);
}

/**
 * Turning suggestions on the first time says which model each difficulty gets,
 * then asks for the key; without one they stay off.
 */
export async function setModelHints(on: boolean): Promise<void> {
  if (on && !(await storedKey()) && !((await introduce()) && (await askForKey()))) return;
  await vscode.workspace.getConfiguration("relay").update("modelHints", on, vscode.ConfigurationTarget.Global);
}

/** What suggestions will pick, before the key is asked for. False when cancelled. */
async function introduce(): Promise<boolean> {
  const providers = await listProviders().catch((): ProviderInfo[] => []);
  const detail = [
    "Jev rates each message you type as simple, standard or complex, and Relay suggests a model for it:",
    tiersSummary(providers),
    "That's for a session's first message. After that the model stays and only the effort follows: low, medium, high, or xhigh when hard work keeps failing.",
    "Change them anytime in Relay's settings (the gear in the sessions bar). What you type is sent to TypeSafe to rate it.",
  ].join("\n\n");
  const pick = await vscode.window.showInformationMessage("Suggest a model for each message", { modal: true, detail }, "Set API Key");
  return !!pick;
}

/** "Claude\n  Simple: Sonnet 5.5 · low\n…" for each usable provider, from `relay.modelHintModels`. */
function tiersSummary(providers: ProviderInfo[]): string {
  const tiers = vscode.workspace.getConfiguration("relay").get<ModelTiers>("modelHintModels", {});
  const usable = providers.filter((p) => !p.unavailable && tiers[p.id]);
  // Before the catalogues load, the ids are better than nothing.
  const list = usable.length ? usable : Object.keys(tiers).map((id): ProviderInfo => ({ id: id as ProviderInfo["id"], label: id, models: [] }));
  return list
    .map((p) => {
      const rows = LEVELS.map(([level, name]) => {
        const tier = tiers[p.id][level];
        if (!tier || !tier.model) return `  ${name}: no suggestion`;
        const model = p.models.find((m) => m.id === tier.model);
        return `  ${name}: ${model ? model.label : tier.model}${tier.effort ? ` · ${tier.effort}` : ""}`;
      });
      return [p.label, ...rows].join("\n");
    })
    .join("\n\n");
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
  keyChanged.fire();
  return key;
}

/**
 * The model and effort for the text in this provider, or undefined when Jev or
 * the settings can't say. With `sessionModel` the model stays and only the effort is suggested.
 */
export async function suggestModel(text: string, provider: ProviderInfo, sessionModel?: string): Promise<ModelSuggestion | undefined> {
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
  if (sessionModel) {
    const current = provider.models.find((m) => m.id === sessionModel);
    return current ? { difficulty, model: current.id, effort: closestEffort(current, SESSION_EFFORT[difficulty]) } : undefined;
  }
  // Settings have no extreme tier: it gets the complex model at xhigh.
  const tiers = vscode.workspace.getConfiguration("relay").get<ModelTiers>("modelHintModels", {});
  const tier = tiers[provider.id] && tiers[provider.id][difficulty === "extreme" ? "complex" : difficulty];
  const model = tier && provider.models.find((m) => m.id === tier.model);
  if (!tier || !model) return undefined;
  const want = difficulty === "extreme" ? SESSION_EFFORT.extreme : tier.effort;
  return { difficulty, model: model.id, effort: want ? closestEffort(model, want) : model.defaultEffort || model.efforts[0] || "" };
}

/** The effort itself if the model accepts it, else the nearest lower one, else the nearest higher one. */
export function closestEffort(model: ModelInfo, want: Effort): Effort {
  if (!model.efforts.length) return "";
  if (model.efforts.includes(want)) return want;
  const i = EFFORT_ORDER.indexOf(want);
  const lower = EFFORT_ORDER.slice(0, Math.max(i, 0)).reverse().find((e) => model.efforts.includes(e));
  const higher = EFFORT_ORDER.slice(i + 1).find((e) => model.efforts.includes(e));
  return lower || higher || model.defaultEffort || model.efforts[0];
}

export async function hasJevKey(): Promise<boolean> {
  return !!(await storedKey());
}

async function storedKey(): Promise<string | undefined> {
  return secrets ? secrets.get(SECRET) : undefined;
}
