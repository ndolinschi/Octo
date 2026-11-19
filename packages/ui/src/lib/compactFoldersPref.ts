import { useSyncExternalStore } from "react";
import { choiceCodec, loadPref, PREFS, writePref } from "./storage";

/**
 * Settings → Editor → "Compact folders" (decision 98; on by default). One value for the window: the tree and the settings
 * row read it through this store, so a change shows at once in an open tree; other windows pick it up from `storage` events.
 * Only the lazy file view and the lazy settings page import this module.
 */
const codec = choiceCodec(["on", "off"] as const, "on");
const listeners = new Set<() => void>();
let value: boolean | null = null;

const read = (): boolean => (value ??= loadPref(PREFS.compactFolders, codec) === "on");

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

/** Saves and applies the choice; `false`, changing nothing, when the browser's storage refused it. */
export function setCompactFolders(on: boolean): boolean {
  if (!writePref(PREFS.compactFolders, codec.stringify(on ? "on" : "off"))) return false;
  value = on;
  for (const fn of listeners) fn();
  return true;
}

export function useCompactFolders(): boolean {
  return useSyncExternalStore(subscribe, read);
}
