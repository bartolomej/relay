import * as path from "path";
import * as vscode from "vscode";
import type { EditorSelection } from "./protocol";

/** Past this the selection goes to the agent as a file and line range only, without its code. */
const MAX_CHARS = 40_000;

const changed = new vscode.EventEmitter<void>();
let current: EditorSelection | undefined;
let pinned: EditorSelection[] = [];

/**
 * The code selected in a file editor, which the composer offers as context for
 * the next message. Focusing Relay leaves it as it was; clearing the selection
 * or switching to an editor without one takes it away.
 */
export const editorSelection = {
  get current(): EditorSelection | undefined {
    return current;
  },
  /** Selections added with Add Selection to Chat; they stay until the next message takes them. */
  get pinned(): EditorSelection[] {
    return pinned;
  },
  /** Adds the editor's selection; false when nothing is selected. A selection already added isn't added twice. */
  pin(editor: vscode.TextEditor, root: string): boolean {
    const sel = selectionIn(editor, root);
    if (!sel) return false;
    if (!pinned.some((p) => JSON.stringify(p) === JSON.stringify(sel))) {
      pinned = [...pinned, sel];
      changed.fire();
    }
    return true;
  },
  unpin(index: number): void {
    if (!pinned[index]) return;
    pinned = pinned.filter((_, i) => i !== index);
    changed.fire();
  },
  clearPinned(): void {
    if (!pinned.length) return;
    pinned = [];
    changed.fire();
  },
  onDidChange: changed.event,
};

export function watchEditorSelection(root: () => string): vscode.Disposable {
  const update = (editor: vscode.TextEditor) => {
    // Output panels, diffs' left sides and other virtual documents aren't files the agent can open; clicking in one keeps the selection.
    if (editor.document.uri.scheme !== "file") return;
    const next = selectionIn(editor, root());
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    changed.fire();
  };
  if (vscode.window.activeTextEditor) update(vscode.window.activeTextEditor);
  return vscode.Disposable.from(
    changed,
    vscode.window.onDidChangeTextEditorSelection((e) => update(e.textEditor)),
    // Undefined when Relay's tab takes the focus, which keeps the selection.
    vscode.window.onDidChangeActiveTextEditor((editor) => editor && update(editor)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (current && doc.uri.scheme === "file" && doc.uri.fsPath === current.fsPath) {
        current = undefined;
        changed.fire();
      }
    }),
  );
}

function selectionIn(editor: vscode.TextEditor, root: string): EditorSelection | undefined {
  const doc = editor.document;
  const sel = editor.selection;
  if (doc.uri.scheme !== "file" || sel.isEmpty) return undefined;
  const text = doc.getText(sel);
  if (!text.trim()) return undefined;
  // A selection of whole lines ends at the start of the next one, which isn't part of it.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const rel = path.relative(root, doc.uri.fsPath);
  return {
    fsPath: doc.uri.fsPath,
    path: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : doc.uri.fsPath,
    startLine: sel.start.line + 1,
    endLine,
    language: doc.languageId,
    text: text.length > MAX_CHARS ? undefined : text,
  };
}
