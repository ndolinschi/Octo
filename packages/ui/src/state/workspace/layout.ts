/**
 * The dock layout: ordered tab groups in one row. Pure functions only; the provider owns state,
 * persistence and side effects. Every operation returns a normalised layout (no empty groups,
 * a valid active tab per group, sizes summing to 1, Chat present exactly once).
 */

import { parseFileKey, type FileKey } from "../../lib/files";
import type { Codec } from "../../lib/storage";

/** A tab's identity. Built only by `CHAT`, `toolTab`, `agentTab`, `fileTab` and `parseTabId`; never concatenate one by hand. */
export type TabId = string & { readonly __brand: "TabId" };
export type Group = { id: string; tabs: TabId[]; active: TabId; size: number };
export type Layout = { groups: Group[]; focused: string };

export type ToolTab = "agents" | "notes" | "files" | "details" | "usage" | "changes" | "memory" | "review" | "side";
export type TabRef =
  { kind: "chat" } | { kind: "tool"; tool: ToolTab } | { kind: "agent"; agentId: string } | { kind: "file"; key: FileKey } | { kind: "run"; name: string };

// The brand is applied here and nowhere else: every call site below has just validated or built the string.
const brand = (id: string) => id as TabId;

export const CHAT = brand("chat");
export const MAX_GROUPS = 4;
const TOOLS: readonly ToolTab[] = ["agents", "notes", "files", "details", "usage", "changes", "memory", "review", "side"];

export const toolTab = (tool: ToolTab): TabId => brand(tool);
export const agentTab = (agentId: string): TabId => brand(`agent:${agentId}`);
export const fileTab = (key: FileKey): TabId => brand(`file:${key}`);
/** The "Run: name" tab of a project command (decision 68). */
export const runTab = (name: string): TabId => brand(`run:${name}`);

/** What a tab id refers to; null for any string that is not a tab id (stored layouts, DOM attributes). */
export function parseTab(id: string): TabRef | null {
  if (id === CHAT) return { kind: "chat" };
  const tool = TOOLS.find((t) => t === id);
  if (tool) return { kind: "tool", tool };
  if (id.startsWith("agent:") && id.length > 6) return { kind: "agent", agentId: id.slice(6) };
  if (id.startsWith("run:") && id.length > 4) return { kind: "run", name: id.slice(4) };
  const key = id.startsWith("file:") ? parseFileKey(id.slice(5)) : null;
  return key ? { kind: "file", key } : null;
}

/** The tab id for a raw string, or null when it is not one (the only way to turn a stored or DOM string into a `TabId`). */
export function parseTabId(raw: string | null | undefined): TabId | null {
  return typeof raw === "string" && parseTab(raw) !== null ? brand(raw) : null;
}

export const closable = (id: TabId) => id !== CHAT;

let counter = 0;
const newGroupId = () => `g${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function chatGroup(): Group {
  return { id: newGroupId(), tabs: [CHAT], active: CHAT, size: 1 };
}

export function initialLayout(): Layout {
  const g = chatGroup();
  return { groups: [g], focused: g.id };
}

export function groupOf(layout: Layout, tab: TabId): Group | undefined {
  return layout.groups.find((g) => g.tabs.includes(tab));
}

/** The group holding Chat. Chat is always open (every operation ends in `normalize`), so the fallback is only for a malformed layout. */
export function chatGroupOf(layout: Layout): Group {
  return groupOf(layout, CHAT) ?? focusedGroup(layout);
}

export function indexOfGroup(layout: Layout, groupId: string): number {
  return layout.groups.findIndex((g) => g.id === groupId);
}

export function focusedGroup(layout: Layout): Group {
  // A layout always has a group; a fresh Chat group stands in for a malformed one instead of returning undefined.
  return layout.groups.find((g) => g.id === layout.focused) ?? layout.groups[0] ?? chatGroup();
}

export function allTabs(layout: Layout): TabId[] {
  return layout.groups.flatMap((g) => g.tabs);
}

/**
 * Drops empty groups (their width goes to the neighbour on the left, else the right), repairs each active tab and the
 * focused group. Does not touch Chat or the sizes: `insertGroup` needs that state before Chat is placed again.
 */
function compact(layout: Layout): Layout {
  const groups: Group[] = [];
  let carry = 0;
  for (const g of layout.groups) {
    const [firstTab] = g.tabs;
    if (firstTab === undefined) {
      const last = groups[groups.length - 1];
      if (last) groups[groups.length - 1] = { ...last, size: last.size + g.size };
      else carry += g.size;
      continue;
    }
    groups.push({ ...g, size: g.size + carry, active: g.tabs.includes(g.active) ? g.active : firstTab });
    carry = 0;
  }
  const focused = groups.some((g) => g.id === layout.focused) ? layout.focused : (groups[0]?.id ?? layout.focused);
  return { groups, focused };
}

/**
 * The invariants every operation ends with: no empty group, a valid active tab per group, Chat present (at the head of
 * the first group when missing), sizes positive and summing to 1. Sizes: when every size is a positive finite number they
 * are scaled to sum to 1; when any is invalid (NaN, 0, negative) all groups are equalised, which keeps the rule simple
 * and the result always whole.
 */
function normalize(layout: Layout): Layout {
  const { groups, focused } = compact(layout);
  if (!groups.some((g) => g.tabs.includes(CHAT))) {
    const head = groups[0];
    if (head) groups[0] = { ...head, tabs: [CHAT, ...head.tabs] };
    else groups.push(chatGroup());
  }
  // Decision 25: the Orchestrator tab is pinned first in whichever group holds it.
  for (const [i, g] of groups.entries()) {
    const at = g.tabs.indexOf(CHAT);
    if (at > 0) groups[i] = { ...g, tabs: [CHAT, ...g.tabs.filter((t) => t !== CHAT)] };
  }
  const valid = groups.every((g) => Number.isFinite(g.size) && g.size > 0);
  const total = groups.reduce((n, g) => n + g.size, 0);
  const sized = groups.map((g) => ({ ...g, size: valid && Number.isFinite(total) ? g.size / total : 1 / groups.length }));
  return { groups: sized, focused: sized.some((g) => g.id === focused) ? focused : (sized[0]?.id ?? focused) };
}

function withGroup(layout: Layout, groupId: string, fn: (g: Group) => Group): Layout {
  return { ...layout, groups: layout.groups.map((g) => (g.id === groupId ? fn(g) : g)) };
}

function insertAfterActive(g: Group, tab: TabId): TabId[] {
  const i = g.tabs.indexOf(g.active);
  const tabs = [...g.tabs];
  tabs.splice(i < 0 ? tabs.length : i + 1, 0, tab);
  return tabs;
}

function removeTab(layout: Layout, tab: TabId): Layout {
  return {
    ...layout,
    groups: layout.groups.map((g) => {
      const i = g.tabs.indexOf(tab);
      if (i < 0) return g;
      const tabs = g.tabs.filter((t) => t !== tab);
      // The neighbour on the right takes over, else the one on the left.
      // An emptied group keeps its old active tab: `compact` removes the group before anyone reads it.
      const active = g.active === tab ? (tabs[Math.min(i, tabs.length - 1)] ?? g.active) : g.active;
      return { ...g, tabs, active };
    }),
  };
}

export function activate(layout: Layout, tab: TabId): Layout {
  const g = groupOf(layout, tab);
  if (!g) return layout;
  if (g.active === tab && layout.focused === g.id) return layout;
  return { ...withGroup(layout, g.id, (x) => ({ ...x, active: tab })), focused: g.id };
}

export function focusGroup(layout: Layout, groupId: string): Layout {
  return layout.focused === groupId || indexOfGroup(layout, groupId) < 0 ? layout : { ...layout, focused: groupId };
}

/** Where a tab goes: an existing group, or a new group right after `after` taking `size` of the row. */
export type Target = { group: string } | { newAfter: string; size: number };

/** Opens `tab` at `target` and focuses it; an already open tab is just focused where it is. */
export function open(layout: Layout, tab: TabId, target: Target): Layout {
  if (groupOf(layout, tab)) return activate(layout, tab);
  if ("group" in target) {
    const g = layout.groups.find((x) => x.id === target.group) ?? focusedGroup(layout);
    return normalize({ ...withGroup(layout, g.id, (x) => ({ ...x, tabs: insertAfterActive(x, tab), active: tab })), focused: g.id });
  }
  return insertGroup(layout, tab, target.newAfter, "right", target.size);
}

/**
 * Puts `tab` where `old` is (same group, same slot) and focuses it: the empty file view turning into
 * the file it opened. An already open `tab` is focused where it is and `old` closes.
 */
export function replace(layout: Layout, old: TabId, tab: TabId): Layout {
  const g = groupOf(layout, old);
  if (!g || old === CHAT) return open(layout, tab, { group: layout.focused });
  if (groupOf(layout, tab)) return activate(close(layout, [old]), tab);
  return { ...withGroup(layout, g.id, (x) => ({ ...x, tabs: x.tabs.map((t) => (t === old ? tab : t)), active: tab })), focused: g.id };
}

/** Closes tabs (Chat never closes); empty groups disappear. */
export function close(layout: Layout, tabs: TabId[]): Layout {
  let next = layout;
  for (const t of tabs) if (closable(t)) next = removeTab(next, t);
  // When the focused group empties, focus moves to its left neighbour (or the right one).
  const i = indexOfGroup(next, next.focused);
  const emptied = next.groups[i];
  if (emptied && !emptied.tabs.length) {
    const neighbour = [...next.groups.slice(0, i)].reverse().find((g) => g.tabs.length) ?? next.groups.slice(i + 1).find((g) => g.tabs.length);
    if (neighbour) next = { ...next, focused: neighbour.id };
  }
  return normalize(next);
}

/** Moves `tab` into `groupId` at `index` (default: after the active tab) and focuses it. */
export function move(layout: Layout, tab: TabId, groupId: string, index?: number): Layout {
  const from = groupOf(layout, tab);
  const to = layout.groups.find((g) => g.id === groupId);
  if (!from || !to) return layout;
  if (from.id === to.id) {
    if (index === undefined) return activate(layout, tab);
    const tabs = to.tabs.filter((t) => t !== tab);
    const at = Math.max(0, Math.min(tabs.length, index > to.tabs.indexOf(tab) ? index - 1 : index));
    tabs.splice(at, 0, tab);
    return normalize({ ...withGroup(layout, to.id, (g) => ({ ...g, tabs, active: tab })), focused: to.id });
  }
  const removed = removeTab(layout, tab);
  const dest = removed.groups.find((g) => g.id === groupId);
  if (!dest) return layout;
  const tabs = [...dest.tabs];
  if (index === undefined) tabs.splice(tabs.indexOf(dest.active) + 1, 0, tab);
  else tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, tab);
  return normalize({ ...withGroup(removed, groupId, (g) => ({ ...g, tabs, active: tab })), focused: groupId });
}

/** Whether moving `tab` into a new group beside `groupId` would change anything (and fit the cap). */
export function canSplit(layout: Layout, tab: TabId, groupId: string): boolean {
  const from = groupOf(layout, tab);
  if (!from) return false;
  if (from.id === groupId && from.tabs.length < 2) return false;
  const willEmpty = from.tabs.length === 1;
  return layout.groups.length - (willEmpty ? 1 : 0) < MAX_GROUPS;
}

/** Moves `tab` into a new group on `side` of `groupId`; `size` (fraction) defaults to half of that group. */
export function split(layout: Layout, tab: TabId, groupId: string, side: "left" | "right", size?: number): Layout {
  if (!canSplit(layout, tab, groupId)) return layout;
  return insertGroup(layout, tab, groupId, side, size);
}

function insertGroup(layout: Layout, tab: TabId, groupId: string, side: "left" | "right", size?: number): Layout {
  // Not normalize(): that would put Chat back into the first group when `tab` is Chat, and the new group would hold it too.
  const removed = compact(removeTab(layout, tab));
  const at = indexOfGroup(removed, groupId);
  if (at < 0 || removed.groups.length >= MAX_GROUPS) return layout;
  const anchor = removed.groups[at];
  if (!anchor) return layout;
  const take = Math.min(size ?? anchor.size / 2, anchor.size * 0.8);
  const group: Group = { id: newGroupId(), tabs: [tab], active: tab, size: take };
  const groups = [...removed.groups];
  groups[at] = { ...anchor, size: anchor.size - take };
  groups.splice(side === "left" ? at : at + 1, 0, group);
  return normalize({ groups, focused: group.id });
}

/** The group a tab in `groupId` moves to: the next one, the previous one for the last, or a new one when alone. */
export function otherSide(layout: Layout, groupId: string): Target | null {
  const i = indexOfGroup(layout, groupId);
  if (i < 0) return null;
  const [only] = layout.groups;
  if (layout.groups.length === 1 && only) return { newAfter: groupId, size: only.size / 2 };
  const target = layout.groups[i + 1 < layout.groups.length ? i + 1 : i - 1];
  return target ? { group: target.id } : null;
}

export function moveToOtherSide(layout: Layout, tab: TabId): Layout {
  const from = groupOf(layout, tab);
  if (!from) return layout;
  const target = otherSide(layout, from.id);
  if (!target) return layout;
  if ("group" in target) return move(layout, tab, target.group);
  return from.tabs.length < 2 ? layout : insertGroup(layout, tab, from.id, "right", target.size);
}

/**
 * Where an agent opens (decision 34): the group right of the orchestrator's, else a new group to its right taking half
 * of it; at the group cap, the last group.
 */
export function besideChat(layout: Layout): Target {
  const home = chatGroupOf(layout);
  const i = indexOfGroup(layout, home.id);
  const right = layout.groups[i + 1];
  if (right) return { group: right.id };
  if (layout.groups.length >= MAX_GROUPS) return { group: layout.groups[layout.groups.length - 1]?.id ?? home.id };
  return { newAfter: home.id, size: home.size / 2 };
}

/**
 * The one tool the header strip marks as open (decision 33: one selected state at a time): the focused group's active
 * tab when it is a tool or a file (a file view counts as "files"), else the rightmost group's; null when neither is.
 */
export function shownTool(layout: Layout): ToolTab | null {
  const kind = (tab: TabId): ToolTab | null => {
    const ref = parseTab(tab);
    return ref?.kind === "tool" ? ref.tool : ref?.kind === "file" ? "files" : null;
  };
  const focused = kind(focusedGroup(layout).active);
  if (focused) return focused;
  for (const g of [...layout.groups].reverse()) {
    const k = kind(g.active);
    if (k) return k;
  }
  return null;
}

/** The group beside Chat's (right, else left), where files and tools open. */
export function sideGroup(layout: Layout): Group | null {
  const i = layout.groups.findIndex((g) => g.tabs.includes(CHAT));
  return layout.groups[i + 1] ?? layout.groups[i - 1] ?? null;
}

/** Moves the divider after group `index` by `delta` (fraction of the row), keeping the left side ≥ `min` and the right side ≥ `minRight` (default `min`). */
export function resize(layout: Layout, index: number, delta: number, min: number, minRight: number = min): Layout {
  const a = layout.groups[index];
  const b = layout.groups[index + 1];
  if (!a || !b) return layout;
  const pair = a.size + b.size;
  // A pair narrower than two minimums splits evenly instead of driving one side negative.
  const floorLeft = pair < min + minRight ? pair * (min / (min + minRight)) : min;
  const floorRight = pair < min + minRight ? pair - floorLeft : minRight;
  const left = Math.max(floorLeft, Math.min(pair - floorRight, a.size + delta));
  const groups = [...layout.groups];
  groups[index] = { ...a, size: left };
  groups[index + 1] = { ...b, size: pair - left };
  return { ...layout, groups };
}

/** Grows `groupId` to at least `min` of the row, taking width evenly from the other groups. */
export function ensureSize(layout: Layout, groupId: string, min: number): Layout {
  const g = layout.groups.find((x) => x.id === groupId);
  if (!g || g.size >= min || layout.groups.length < 2) return layout;
  const rest = 1 - g.size;
  const scale = (1 - min) / rest;
  return { ...layout, groups: layout.groups.map((x) => ({ ...x, size: x.id === groupId ? min : x.size * scale })) };
}

export function equalize(layout: Layout): Layout {
  return { ...layout, groups: layout.groups.map((g) => ({ ...g, size: 1 / layout.groups.length })) };
}

/** Drops tabs `keep` rejects (stale agents, files in removed folders); returns the same object when nothing changes. */
export function prune(layout: Layout, keep: (tab: TabId) => boolean): Layout {
  const stale = allTabs(layout).filter((t) => t !== CHAT && !keep(t));
  return stale.length ? close(layout, stale) : layout;
}

/* ---------- persistence ---------- */

type Stored = { v: 1; groups: { tabs: string[]; active: string; size: number }[]; focused: number };

export function serialize(layout: Layout): string {
  const stored: Stored = {
    v: 1,
    groups: layout.groups.map((g) => ({ tabs: g.tabs, active: g.active, size: Math.round(g.size * 1e4) / 1e4 })),
    focused: Math.max(0, indexOfGroup(layout, layout.focused)),
  };
  return JSON.stringify(stored);
}

type StoredGroup = { tabs: unknown[]; active: unknown; size: unknown };

function storedGroup(g: unknown): StoredGroup | null {
  if (typeof g !== "object" || g === null || !("tabs" in g) || !Array.isArray(g.tabs)) return null;
  const tabs: unknown[] = g.tabs;
  return { tabs, active: "active" in g ? g.active : undefined, size: "size" in g ? g.size : undefined };
}

/** Parses a stored layout; anything malformed, unknown or duplicated is dropped silently. */
export function deserialize(raw: string | null): Layout | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("v" in data) || data.v !== 1 || !("groups" in data) || !Array.isArray(data.groups)) return null;
    const stored: unknown[] = data.groups;
    const seen = new Set<TabId>();
    const groups: Group[] = [];
    for (const entry of stored.slice(0, MAX_GROUPS)) {
      const g = storedGroup(entry);
      if (!g) continue;
      const tabs: TabId[] = [];
      for (const tab of g.tabs) {
        const t = parseTabId(typeof tab === "string" ? tab : null);
        // First occurrence wins, within a group as well as across groups.
        if (t === null || seen.has(t)) continue;
        seen.add(t);
        tabs.push(t);
      }
      const size = typeof g.size === "number" && g.size > 0 && g.size <= 1 ? g.size : 0;
      groups.push({ id: newGroupId(), tabs, active: parseTabId(typeof g.active === "string" ? g.active : null) ?? tabs[0] ?? CHAT, size });
    }
    const focusedIndex = "focused" in data && typeof data.focused === "number" ? data.focused : 0;
    const focused = groups[focusedIndex]?.id ?? groups[0]?.id ?? "";
    return normalize({ groups, focused });
  } catch {
    return null;
  }
}

/** The stored layout (`octo.layout.{projectId}`); nothing usable stored reads as Chat alone. */
export const layoutCodec: Codec<Layout> = { parse: (raw) => deserialize(raw) ?? initialLayout(), stringify: serialize };
