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

/** What "Run" gives back when it folds to its icon button (58 → 28 is 30; a little over, so a fold never springs back at once). */
export const RUN_FREED = 32;

/**
 * Decision 90, narrow strips: the tab list is guaranteed `TAB_MIN` per tab (the "+" is already outside `room`). To make room,
 * first "N agents" folds to its glyph with the count, then "Run" to an icon-only menu button. `agents` and `run` are what each
 * gives back when folded (0: not there; overestimate it a little, never under); `*Compact` say whether they are folded now. What they gave back is added to `room`
 * before deciding, so folding does not make them come straight back.
 */
export function endPlan(i: { room: number; tabs: number; agents: number; run: number; agentsCompact: boolean; runCompact: boolean }): {
  agentsCompact: boolean;
  runCompact: boolean;
} {
  if (i.room <= 0 || i.tabs <= 0) return { agentsCompact: false, runCompact: false };
  const need = i.tabs * TAB_MIN + TAB_GAP * (i.tabs - 1);
  const base = i.room - (i.agentsCompact ? i.agents : 0) - (i.runCompact ? i.run : 0);
  const agentsCompact = i.agents > 0 && need > base;
  const runCompact = i.run > 0 && need > base + (agentsCompact ? i.agents : 0);
  return { agentsCompact, runCompact };
}
