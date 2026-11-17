import type { PurposeTool } from "./toolPurpose";

export type TabFeatureKey = PurposeTool;
export type TabFeatureFlags = Readonly<Record<TabFeatureKey, boolean>>;
export type TabFeatureOverrides = Partial<Record<TabFeatureKey, boolean>>;

/**
 * UI-only feature flags for dock tool tabs (and the top-bar Sessions button/picker).
 * Disabled tabs do not mount or appear in menus, pickers, palette or slash commands;
 * left-sidebar project sessions and the Go harness remain completely unaffected.
 */
export const DEFAULT_TAB_FLAGS = {
  sessions: false,
  agents: false,
  notes: false,
  details: false,
  usage: false,
  memory: false,
  files: true,
  browser: true,
  terminal: true,
  processes: true,
  changes: true,
  review: true,
  side: true,
} as const satisfies Record<TabFeatureKey, boolean>;

const KEYS = Object.keys(DEFAULT_TAB_FLAGS) as readonly TabFeatureKey[];
const isKey = (k: string): k is TabFeatureKey => (KEYS as readonly string[]).includes(k);

/**
 * Resolves tab feature flags from `DEFAULT_TAB_FLAGS`, host `overrides`, and optional `?tabs=` URL query
 * (`?tabs=all`, `?tabs=none`, or comma-separated `sessions,usage` / `all,-notes`).
 */
export function resolveTabFlags(overrides?: TabFeatureOverrides, search = ""): TabFeatureFlags {
  const next: Record<TabFeatureKey, boolean> = { ...DEFAULT_TAB_FLAGS };
  if (overrides) {
    for (const k of KEYS) {
      const v = overrides[k];
      if (typeof v === "boolean") next[k] = v;
    }
  }
  const raw = search ? new URLSearchParams(search).get("tabs") : null;
  if (!raw) return next;
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token === "all") {
      for (const k of KEYS) next[k] = true;
    } else if (token === "none") {
      for (const k of KEYS) next[k] = false;
    } else if (token.startsWith("-")) {
      const sub = token.slice(1);
      if (isKey(sub)) next[sub] = false;
    } else if (isKey(token)) {
      next[token] = true;
    }
  }
  return next;
}

/** Whether a dock tool tab is enabled given UI feature flags and per-project settings (`memoryBlocked`). */
export function isTabEnabled(flags: TabFeatureFlags, tool: TabFeatureKey, opts?: { memoryBlocked?: boolean | undefined }): boolean {
  return flags[tool] && !(tool === "memory" && opts?.memoryBlocked === true);
}
