/**
 * Decision 25 — browser-grade tabs, the pure part: overflow, live displacement while dragging, MRU order, the
 * closed-tab stack and Ctrl/Cmd+1…9. React-free; `dock/drag.ts` and the workspace provider use it.
 */

export const TAB_MAX = 200;
/**
 * The narrowest a tab gets while the strip does not scroll (decisions 83 and 90): inset, icon, gap, at least four characters of
 * the title with the ellipsis, and the active tab's close place — never the one-letter "F" a pinned button could squeeze out.
 */
export const TAB_MIN = 96;
/** The close button's place after the title (16 + the 8px inset). */
export const TAB_CLOSE_ROOM = 24;
export const TAB_GAP = 4;

/**
 * Decision 83: a tab is as wide as its icon, title and close button need (up to `TAB_MAX`, the title truncating); CSS shrinks
 * them evenly when the strip is short, down to `TAB_MIN`. Only when even that does not fit does the strip scroll: this says when
 * (`avail` is the room for the tabs; 0 = not measured yet).
 */
export function tabsOverflow(avail: number, n: number): boolean {
  return avail > 0 && n > 0 && n * TAB_MIN + TAB_GAP * (n - 1) > avail;
}

/**
 * C2 (V3, only whole tabs): the narrowest a tab with a long title (a file, a session) is drawn; its title truncates down to this
 * (about 13 characters). A tab whose title fits in less is never narrower than its whole title and its close place.
 */
export const TAB_FLOOR = 144;

/** A tab's unsqueezed width: its parts and whole title (`natural`), plus the close place when it keeps one, within TAB_MIN…TAB_MAX. */
export function tabWant(natural: number, close: boolean): number {
  return Math.min(TAB_MAX, Math.max(TAB_MIN, natural + (close ? TAB_CLOSE_ROOM : 0)));
}

/** The narrowest the tab is drawn: its whole title, or `TAB_FLOOR` for a long one. */
export function tabFloor(natural: number, close: boolean): number {
  return Math.min(tabWant(natural, close), TAB_FLOOR);
}

export type StripTab<T> = {
  id: T;
  /** The tab's parts and whole title without the close place (px); undefined while it has never been laid out. */
  natural: number | undefined;
  /** It keeps its close place (the active tab, an unsaved file, or every tab while the strip is not short). */
  close: boolean;
  /** Always shown: the active tab and the pinned Orchestrator tab. */
  keep: boolean;
};

/**
 * C2 (V3): which tabs the strip shows. When every tab fits at its floor, all of them; otherwise the kept ones (the active tab
 * first), then the most recently used (`recent`, most recent first) while they fit beside the "All tabs" button (`allRoom`),
 * which then lists the rest. Shown tabs keep strip order. Nothing measured (`natural` undefined) shows everything, so a tab is
 * measured before it can be hidden; the answer depends only on these numbers, never on the widths drawn, so there is no
 * measure → change → measure loop.
 */
export function fitStrip<T>(i: { room: number; tabs: readonly StripTab<T>[]; recent: readonly T[]; allRoom: number }): { shown: T[]; hidden: number } {
  const all = i.tabs.map((t) => t.id);
  if (i.room <= 0 || i.tabs.some((t) => t.natural === undefined)) return { shown: all, hidden: 0 };
  const floor = new Map(i.tabs.map((t) => [t.id, tabFloor(t.natural ?? 0, t.close)]));
  const total = (ids: Iterable<T>) => {
    let sum = 0;
    let n = 0;
    for (const id of ids) {
      sum += floor.get(id) ?? 0;
      n += 1;
    }
    return sum + TAB_GAP * Math.max(0, n - 1);
  };
  if (total(all) <= i.room) return { shown: all, hidden: 0 };
  const budget = i.room - i.allRoom;
  const picked = new Set(i.tabs.filter((t) => t.keep).map((t) => t.id));
  let used = total(picked);
  const order = [...i.recent.filter((id) => floor.has(id)), ...all.filter((id) => !i.recent.includes(id))];
  for (const id of order) {
    if (picked.has(id)) continue;
    const w = (floor.get(id) ?? 0) + (picked.size > 0 ? TAB_GAP : 0);
    if (used + w > budget) continue;
    picked.add(id);
    used += w;
  }
  const shown = all.filter((id) => picked.has(id));
  return { shown, hidden: all.length - shown.length };
}

/**
 * C2 (V3): a drag measures the shown tabs only, so its index `k` (into `shown`, "before shown[k]", `shown.length` = after the
 * last) becomes an index into `tabs` (the group's tabs, what `layout.move` takes): before the first shown tab at or after `k`
 * that is in the group, else after the last such one before it. Identity when nothing is hidden.
 */
export function shownToLayoutIndex<T>(shown: readonly T[], tabs: readonly T[], k: number): number {
  if (shown.length === tabs.length && shown.every((t, j) => tabs[j] === t)) return k;
  const inGroup = (j: number) => {
    const t = shown[j];
    return t === undefined ? -1 : tabs.indexOf(t);
  };
  for (let j = Math.max(0, k); j < shown.length; j++) if (inGroup(j) >= 0) return inGroup(j);
  for (let j = Math.min(k, shown.length) - 1; j >= 0; j--) if (inGroup(j) >= 0) return inGroup(j) + 1;
  return Math.min(k, tabs.length);
}

export type Slot = { left: number; width: number };

/**
 * Where the dragged tab lands in a strip, as an index into the strip's tabs *without* it: the number of tabs whose
 * centre lies left of the dragged tab's centre. `from` is its own index (−1 when it comes from another strip);
 * `pinned` tabs at the start (the Orchestrator tab) are never displaced.
 */
export function insertionIndex(slots: readonly Slot[], from: number, center: number, pinned: number): number {
  let index = 0;
  slots.forEach((s, i) => {
    if (i !== from && s.left + s.width / 2 < center) index += 1;
  });
  return Math.max(pinned, index);
}

/** How far tab `i` slides (px) while the dragged tab moves from `from` to `to` (−1 = it comes from elsewhere). */
export function slotShift(i: number, from: number, to: number, step: number): number {
  if (i === from) return 0;
  if (from < 0) return i >= to ? step : 0;
  if (from < to && i > from && i <= to) return -step;
  if (to < from && i >= to && i < from) return step;
  return 0;
}

/** `layout.move` takes an index into the strip *with* the tab still in it; `to` is into the strip without it. */
export function toMoveIndex(from: number, to: number): number {
  return from >= 0 && to >= from ? to + 1 : to;
}

/** The dragged tab's left edge, kept inside the strip while it is in its strip. */
export function clampLeft(left: number, width: number, min: number, max: number): number {
  return Math.max(min, Math.min(max - width, left));
}

/* ---------- most recently used ---------- */

export function mruTouch<T>(list: readonly T[], item: T, max = 50): T[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, max);
}

/** The cycling order: tabs by recency (most recent first), never-used ones after in strip order. */
export function mruOrder<T>(mru: readonly T[], tabs: readonly T[]): T[] {
  const set = new Set(tabs);
  const used = mru.filter((t) => set.has(t));
  return [...used, ...tabs.filter((t) => !used.includes(t))];
}

/* ---------- closed tabs ---------- */

export type Closed<T> = { tab: T; group: string; index: number };
export const CLOSED_MAX = 20;

export function pushClosed<T>(stack: readonly Closed<T>[], entries: readonly Closed<T>[]): Closed<T>[] {
  return [...stack, ...entries].slice(-CLOSED_MAX);
}

/** The most recent closed tab that is not open again; the stack without it (and without the skipped open ones). */
export function takeClosed<T>(stack: readonly Closed<T>[], isOpen: (tab: T) => boolean): { entry: Closed<T> | null; rest: Closed<T>[] } {
  const rest = [...stack];
  while (rest.length) {
    const entry = rest.pop();
    if (entry && !isOpen(entry.tab)) return { entry, rest };
  }
  return { entry: null, rest };
}

export type RecentTabEntry<T> = { tab: T; status: "closed" | "open" };

/**
 * Deduplicated recent tabs for the "+" tab picker: newest-closed tabs not currently open first,
 * then most-recently-used open tabs (excluding `active` and filtered entries).
 */
export function recentPickerTabs<T>(i: {
  closed: readonly Closed<T>[];
  mru: readonly T[];
  open: ReadonlySet<T>;
  active: T | null;
  max?: number;
  exclude?: (tab: T) => boolean;
}): RecentTabEntry<T>[] {
  const max = i.max ?? 6;
  const seen = new Set<T>();
  const out: RecentTabEntry<T>[] = [];
  const skip = (t: T) => seen.has(t) || (i.exclude?.(t) ?? false);

  for (let k = i.closed.length - 1; k >= 0 && out.length < max; k -= 1) {
    const entry = i.closed[k];
    if (!entry) continue;
    const t = entry.tab;
    if (skip(t) || i.open.has(t)) continue;
    seen.add(t);
    out.push({ tab: t, status: "closed" });
  }

  for (const t of i.mru) {
    if (out.length >= max) break;
    if (skip(t) || t === i.active || !i.open.has(t)) continue;
    seen.add(t);
    out.push({ tab: t, status: "open" });
  }

  return out;
}

/* ---------- Ctrl/Cmd+1…9 ---------- */

/** 1…8 by position, 9 = the last tab; null when there is no such tab. */
export function jumpIndex(digit: number, n: number): number | null {
  if (n <= 0 || digit < 1 || digit > 9) return null;
  if (digit === 9) return n - 1;
  return digit - 1 < n ? digit - 1 : null;
}

/**
 * Ctrl+Tab's walk (decision 25; live test: "pressed twice it behaves oddly when focus moves to another group"): the
 * first press fixes the group and its MRU order; every press while Ctrl is held steps through that order only — even
 * if activating a tab moves focus elsewhere — and the release commits the tab reached (it becomes the most recent).
 */
export type TabWalk<T> = { group: string; order: readonly T[]; step: number };

export function walkPress<T>(
  walk: TabWalk<T> | null,
  start: { group: string; order: readonly T[] },
  back: boolean,
): { walk: TabWalk<T>; target: T | undefined } {
  const w = walk ?? { group: start.group, order: start.order, step: 0 };
  const step = w.step + (back ? -1 : 1);
  const n = w.order.length;
  return { walk: { ...w, step }, target: n ? w.order[((step % n) + n) % n] : undefined };
}

export function walkRelease<T>(walk: TabWalk<T> | null): T | undefined {
  if (!walk) return undefined;
  const n = walk.order.length;
  return n ? walk.order[((walk.step % n) + n) % n] : undefined;
}

/**
 * Decision 90: what gives way first when the top row is short. Tabs have priority: (1) the pinned command buttons fold into the
 * "Run" menu, (2) an inactive tab gives up its reserved close place (the button shows over the end of the title on hover), (3) the
 * tabs shrink towards `TAB_MIN`, (4) the strip scrolls. `wanted` is the width every tab would take unconstrained (gaps included),
 * `room` the width the tabs have now, `pinned` the width the pinned buttons take (0: none), `collapsed` whether they are folded now.
 * The pinned buttons' width is added back before deciding, so folding them does not make them come straight back.
 */
export function stripPlan(i: { room: number; wanted: number; pinned: number; collapsed: boolean }): { collapse: boolean; overlay: boolean } {
  if (i.room <= 0 || i.wanted <= 0) return { collapse: false, overlay: false };
  const ifShown = i.room - (i.collapsed ? i.pinned : 0);
  const collapse = i.pinned > 0 && i.wanted > ifShown;
  return { collapse, overlay: i.wanted > ifShown + (collapse ? i.pinned : 0) };
}

/**
 * Decision 90, narrow strips: the tab list is guaranteed `TAB_MIN` per tab (the "+" is already outside `room`). To make room,
 * "N agents" folds to its glyph with the count. `agents` is what it gives back when folded (0: not there; overestimate it a
 * little, never under); `agentsCompact` says whether it is folded now. What it gave back is added to `room` before deciding,
 * so folding does not make it come straight back.
 */
export function endPlan(i: { room: number; tabs: number; agents: number; agentsCompact: boolean }): {
  agentsCompact: boolean;
} {
  if (i.room <= 0 || i.tabs <= 0) return { agentsCompact: false };
  const need = i.tabs * TAB_MIN + TAB_GAP * (i.tabs - 1);
  const base = i.room - (i.agentsCompact ? i.agents : 0);
  return { agentsCompact: i.agents > 0 && need > base };
}

/**
 * Resolves a drop at `targetIndex` (pre-removal index in `shown`, or in `allTabs` when nothing is hidden) inside the
 * combined single strip of narrow mode (`ws.narrow`) to the destination `(groupId, index)` expected by `layout.move`.
 */
export function narrowStripDropTarget<T>(
  groups: readonly { id: string; tabs: readonly T[] }[],
  tab: T,
  shown: readonly T[] | undefined,
  targetIndex: number,
): { groupId: string; index: number } | null {
  if (groups.length === 0) return null;
  const all = groups.flatMap((g) => g.tabs);
  const fromAll = all.indexOf(tab);
  if (fromAll < 0) return null;
  const preIdx = shown ? shownToLayoutIndex(shown, all, targetIndex) : targetIndex;
  const afterIdx = Math.max(0, Math.min(all.length - 1, preIdx > fromAll ? preIdx - 1 : preIdx));
  let offset = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g) continue;
    const rem = g.tabs.filter((t) => t !== tab);
    if (afterIdx <= offset + rem.length || i === groups.length - 1) {
      const inRem = Math.max(0, Math.min(rem.length, afterIdx - offset));
      const fromInGroup = g.tabs.indexOf(tab);
      if (fromInGroup >= 0) {
        return { groupId: g.id, index: inRem > fromInGroup ? inRem + 1 : inRem };
      }
      return { groupId: g.id, index: inRem };
    }
    offset += rem.length;
  }
  return null;
}
