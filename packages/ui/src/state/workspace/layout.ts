/**
 * The dock layout: ordered tab groups in one row. Pure functions only; the provider owns state,
 * persistence and side effects. Every operation returns a normalised layout (no empty groups,
 * a valid active tab per group, sizes summing to 1, Chat present exactly once).
 */

export type TabId = string;
export type Group = { id: string; tabs: TabId[]; active: TabId; size: number };
export type Layout = { groups: Group[]; focused: string };

export type ToolTab = "agents" | "notes" | "files" | "details";
export type TabRef = { kind: "chat" } | { kind: "tool"; tool: ToolTab } | { kind: "agent"; agentId: string } | { kind: "file"; key: string };

export const CHAT: TabId = "chat";
export const MAX_GROUPS = 4;
const TOOLS: readonly string[] = ["agents", "notes", "files", "details"];

export const agentTab = (agentId: string): TabId => `agent:${agentId}`;
export const fileTab = (key: string): TabId => `file:${key}`;

export function parseTab(id: TabId): TabRef | null {
  if (id === CHAT) return { kind: "chat" };
  if (TOOLS.includes(id)) return { kind: "tool", tool: id as ToolTab };
  if (id.startsWith("agent:") && id.length > 6) return { kind: "agent", agentId: id.slice(6) };
  if (id.startsWith("file:") && id.includes("\u0000")) return { kind: "file", key: id.slice(5) };
  return null;
}

export const closable = (id: TabId) => id !== CHAT;

let counter = 0;
const newGroupId = () => `g${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function initialLayout(): Layout {
  const g: Group = { id: newGroupId(), tabs: [CHAT], active: CHAT, size: 1 };
  return { groups: [g], focused: g.id };
}

export function groupOf(layout: Layout, tab: TabId): Group | undefined {
  return layout.groups.find((g) => g.tabs.includes(tab));
}

export function indexOfGroup(layout: Layout, groupId: string): number {
  return layout.groups.findIndex((g) => g.id === groupId);
}

export function focusedGroup(layout: Layout): Group {
  return layout.groups.find((g) => g.id === layout.focused) ?? layout.groups[0];
}

export function allTabs(layout: Layout): TabId[] {
  return layout.groups.flatMap((g) => g.tabs);
}

function normalize(layout: Layout): Layout {
  // Removing an empty group hands its width to the neighbour on its left (or right).
  const groups: Group[] = [];
  let carry = 0;
  for (const g of layout.groups) {
    if (!g.tabs.length) {
      if (groups.length) groups[groups.length - 1] = { ...groups[groups.length - 1], size: groups[groups.length - 1].size + g.size };
      else carry += g.size;
      continue;
    }
    groups.push({ ...g, size: g.size + carry, active: g.tabs.includes(g.active) ? g.active : g.tabs[0] });
    carry = 0;
  }
  if (!groups.some((g) => g.tabs.includes(CHAT))) {
    if (groups.length) groups[0] = { ...groups[0], tabs: [CHAT, ...groups[0].tabs] };
    else groups.push({ id: newGroupId(), tabs: [CHAT], active: CHAT, size: 1 });
  }
  const total = groups.reduce((n, g) => n + (Number.isFinite(g.size) && g.size > 0 ? g.size : 0), 0);
  const sized = groups.map((g) => ({
    ...g,
    size: total > 0 && Number.isFinite(g.size) && g.size > 0 ? g.size / total : 1 / groups.length,
  }));
  const focused = sized.some((g) => g.id === layout.focused) ? layout.focused : sized[0].id;
  return { groups: sized, focused };
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
      const active = g.active === tab ? (tabs[Math.min(i, tabs.length - 1)] ?? "") : g.active;
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
  if (i >= 0 && !next.groups[i].tabs.length) {
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
    return { ...withGroup(layout, to.id, (g) => ({ ...g, tabs, active: tab })), focused: to.id };
  }
  const removed = removeTab(layout, tab);
  const dest = removed.groups.find((g) => g.id === groupId)!;
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
  const removed = normalize(removeTab(layout, tab));
  const at = indexOfGroup(removed, groupId);
  if (at < 0 || removed.groups.length >= MAX_GROUPS) return layout;
  const anchor = removed.groups[at];
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
  if (layout.groups.length === 1) return { newAfter: groupId, size: layout.groups[0].size / 2 };
  const j = i + 1 < layout.groups.length ? i + 1 : i - 1;
  return { group: layout.groups[j].id };
}

export function moveToOtherSide(layout: Layout, tab: TabId): Layout {
  const from = groupOf(layout, tab);
  if (!from) return layout;
  const target = otherSide(layout, from.id);
  if (!target) return layout;
  if ("group" in target) return move(layout, tab, target.group);
  return from.tabs.length < 2 ? layout : insertGroup(layout, tab, from.id, "right", target.size);
}

/** The group beside Chat's (right, else left), where files and tools open. */
export function sideGroup(layout: Layout): Group | null {
  const i = layout.groups.findIndex((g) => g.tabs.includes(CHAT));
  return layout.groups[i + 1] ?? layout.groups[i - 1] ?? null;
}

/** Moves the divider after group `index` by `delta` (fraction of the row), keeping both sides ≥ `min`. */
export function resize(layout: Layout, index: number, delta: number, min: number): Layout {
  const a = layout.groups[index];
  const b = layout.groups[index + 1];
  if (!a || !b) return layout;
  const pair = a.size + b.size;
  const left = Math.max(min, Math.min(pair - min, a.size + delta));
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

/** Parses a stored layout; anything malformed, unknown or duplicated is dropped silently. */
export function deserialize(raw: string | null): Layout | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<Stored>;
    if (data.v !== 1 || !Array.isArray(data.groups)) return null;
    const seen = new Set<string>();
    const groups: Group[] = [];
    for (const g of data.groups.slice(0, MAX_GROUPS)) {
      if (!g || !Array.isArray(g.tabs)) continue;
      const tabs = g.tabs.filter((t): t is string => typeof t === "string" && parseTab(t) !== null && !seen.has(t));
      for (const t of tabs) seen.add(t);
      const size = typeof g.size === "number" && g.size > 0 && g.size <= 1 ? g.size : 0;
      groups.push({ id: newGroupId(), tabs, active: typeof g.active === "string" ? g.active : "", size });
    }
    const focusedIndex = typeof data.focused === "number" ? data.focused : 0;
    const focused = groups[focusedIndex]?.id ?? groups[0]?.id ?? "";
    return normalize({ groups, focused });
  } catch {
    return null;
  }
}
