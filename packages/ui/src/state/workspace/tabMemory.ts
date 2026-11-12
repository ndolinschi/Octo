import { toolTab, type TabId } from "./layout";
import { isUsageView } from "../../lib/usageView";

/**
 * Per-tab view memory (scroll positions, composer draft, view modes) that survives a tab remounting when it moves between
 * groups. Every entry is declared through a typed `Slot`, so a read returns the declared type or `undefined`: no casts, and a
 * value of the wrong shape (a slot name reused by mistake) reads back as absent.
 */
export type Slot<T> = { readonly name: string; readonly check: (value: unknown) => value is T };

/** Declares a slot: `name` is unique per tab, `check` validates what is read back. */
export function slot<T>(name: string, check: (value: unknown) => value is T): Slot<T> {
  return { name, check };
}

export class TabMemory {
  private readonly values = new Map<string, unknown>();

  private keyOf(tab: TabId, s: Slot<unknown>): string {
    return `${tab}:${s.name}`;
  }

  get<T>(tab: TabId, s: Slot<T>): T | undefined {
    const value = this.values.get(this.keyOf(tab, s));
    return s.check(value) ? value : undefined;
  }

  set<T>(tab: TabId, s: Slot<T>, value: T): void {
    this.values.set(this.keyOf(tab, s), value);
  }
}

/** Guards for common slot shapes. */
export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number";
export const isBooleanRecord = (v: unknown): v is Record<string, boolean> =>
  typeof v === "object" && v !== null && Object.values(v).every((x) => typeof x === "boolean");

/** The Usage tab's controls; also written by the workspace when Home asks for Usage over all projects. */
export const USAGE_VIEW = slot("usage-view", isUsageView);

/** The side question is kept when its tab closes (decision 40: cleared on close unless pinned). */
export const SIDE_PINNED = slot("side-pinned", (v): v is boolean => typeof v === "boolean");

/** Which Memory view the tab opens on once ("context": the context button's "Open context details"); read and cleared on mount. */
export const MEMORY_START = slot("memory-start", (v): v is string => typeof v === "string");

const memoryViewListeners = new Set<() => void>();

/**
 * Asks the Memory tab for a view ("context": the context button's "Open context details"): writes the request the tab reads
 * on mount, and tells a Memory tab that is already mounted (parity B7), which switches at once.
 */
export function requestMemoryView(memory: TabMemory, view: string): void {
  memory.set(toolTab("memory"), MEMORY_START, view);
  for (const listener of memoryViewListeners) listener();
}

/** A mounted Memory tab listens for `requestMemoryView`. */
export function onMemoryViewRequest(listener: () => void): () => void {
  memoryViewListeners.add(listener);
  return () => void memoryViewListeners.delete(listener);
}
