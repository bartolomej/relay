import * as vscode from "vscode";

const changed = new vscode.EventEmitter<boolean>();
let on = false;

/** Whether this window serves Relay to the phone. The panels and keep-awake follow it. */
export const remoteStatus = {
  get on(): boolean {
    return on;
  },
  set(value: boolean): void {
    if (value === on) return;
    on = value;
    // Picks which Remote button the view title shows.
    void vscode.commands.executeCommand("setContext", "relay.remoteOn", value);
    changed.fire(value);
  },
  onDidChange: changed.event,
};
