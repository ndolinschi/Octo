import { useSyncExternalStore } from "react";
import { choiceCodec, loadPref, PREFS, writePref } from "./storage";

export type FileIconTheme = "vscode" | "minimal";

/**
 * Settings → Editor → "File icons" (VSCode icons by default). Shared window store so changing the setting updates any
 * open file tree immediately; only the lazy file view and settings page import this module.
 */
const codec = choiceCodec<FileIconTheme>(["vscode", "minimal"] as const, "vscode");
const listeners = new Set<() => void>();
let value: FileIconTheme | null = null;

const read = (): FileIconTheme => (value ??= loadPref(PREFS.fileIcons, codec));

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = () => {
    value = null;
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** Saves and applies the choice; `false`, changing nothing, when storage refused it. */
export function setFileIconTheme(theme: FileIconTheme): boolean {
  if (!writePref(PREFS.fileIcons, codec.stringify(theme))) return false;
  value = theme;
  for (const fn of listeners) fn();
  return true;
}

export function useFileIconTheme(): FileIconTheme {
  return useSyncExternalStore(subscribe, read);
}
