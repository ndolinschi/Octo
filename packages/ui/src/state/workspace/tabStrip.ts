/**
 * Decision 25 — browser-grade tabs, the pure part: sizing, live displacement while dragging, MRU order, the
 * closed-tab stack and Ctrl/Cmd+1…9. React-free; `dock/drag.ts` and the workspace provider use it.
 */

export const TAB_MAX = 200;
export const TAB_MIN = 96;
export const TAB_ICON = 40;
export const TAB_GAP = 4;

export type TabSizing = { widths: number[]; iconOnly: boolean[]; overflow: boolean };

/**
 * Tabs share the strip: each up to 200px, shrinking evenly to 96; below that the inactive tabs become icon-only
 * (40px) while the active one keeps the rest of the room (96–200); only then does the strip scroll (`overflow`).
 */
export function tabSizing(avail: number, n: number, active: number): TabSizing {
  if (n <= 0) return { widths: [], iconOnly: [], overflow: false };
  const gaps = TAB_GAP * (n - 1);
  const share = Math.floor((avail - gaps) / n);
  if (share >= TAB_MIN || avail <= 0) {
    const w = avail <= 0 ? TAB_MAX : Math.min(TAB_MAX, share);
    return { widths: Array<number>(n).fill(w), iconOnly: Array<boolean>(n).fill(false), overflow: false };
  }
  const activeWidth = Math.max(TAB_MIN, Math.min(TAB_MAX, avail - gaps - (n - 1) * TAB_ICON));
  const widths = Array.from({ length: n }, (_, i) => (i === active ? activeWidth : TAB_ICON));
  const total = widths.reduce((a, b) => a + b, 0) + gaps;
  return { widths, iconOnly: widths.map((_, i) => i !== active), overflow: total > avail };
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
