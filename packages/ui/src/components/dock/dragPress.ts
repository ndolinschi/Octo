import type { TabId } from "../../state/workspace/layout";
import { clampLeft, insertionIndex, toMoveIndex, type Slot } from "../../state/workspace/tabStrip";
import type { DropTarget, WorkspaceValue } from "../../state/workspace/WorkspaceProvider";
import { getDrag, setDrag, setSettle, type Rect } from "./dragStore";

/* The pointer part of dragging a tab (decision 25), loaded with the first press (`drag.ts`). It reads the dock's `data-*` drag protocol. */

/** Movement before a press on a tab becomes a drag; touch needs a hold first. */
const THRESHOLD = 4;
const TOUCH_HOLD_MS = 250;
/** How far the pointer may leave its own strip (above / below) before the tab detaches. */
const DETACH = 24;
/** Inset of a drop zone inside the group body; share of the body's width, either side, that means "split here". */
const INSET = 6;
const EDGE = 0.25;
/** The window's far right edge: dropping there makes a new group after the last one. */
const FAR_EDGE = 24;

type StripSnap = { group: string; strip: DOMRect; list: DOMRect; slots: Slot[]; pinned: number };

function snapshot(): StripSnap[] {
  // Width transitions (an activated icon-only tab widening) end now, so every slot is measured where it will rest.
  for (const w of document.querySelectorAll<HTMLElement>("[data-tab-wrapper]")) for (const a of w.getAnimations()) a.finish();
  return [...document.querySelectorAll<HTMLElement>("[data-dock-group]")].flatMap((el) => {
    const group = el.dataset.dockGroup;
    const strip = el.querySelector<HTMLElement>("[data-strip]");
    const list = el.querySelector<HTMLElement>("[data-tab-list]");
    if (!group || !strip || !list || el.hidden) return [];
    const wrappers = [...list.querySelectorAll<HTMLElement>("[data-tab-wrapper]")];
    return [
      {
        group,
        strip: strip.getBoundingClientRect(),
        list: list.getBoundingClientRect(),
        slots: wrappers.map((w) => {
          const r = w.getBoundingClientRect();
          return { left: r.left, width: r.width };
        }),
        pinned: wrappers.filter((w) => w.dataset.pinned !== undefined).length,
      },
    ];
  });
}

function bodyHit(ws: WorkspaceValue, tab: TabId, x: number, y: number): { target: DropTarget; indicator: Rect } | null {
  const groups = [...document.querySelectorAll<HTMLElement>("[data-dock-group]")].filter((g) => !g.hidden);
  const lastEl = groups[groups.length - 1];
  const last = lastEl?.getBoundingClientRect();
  const lastId = lastEl?.dataset.dockGroup;
  // The far right edge of the dock: a new group after the last one.
  if (last && lastId && x >= last.right - FAR_EDGE && x <= last.right + FAR_EDGE && y >= last.top && y <= last.bottom) {
    const target: DropTarget = { kind: "split", group: lastId, side: "right" };
    const body = lastEl.querySelector<HTMLElement>("[data-dock-body]")?.getBoundingClientRect();
    if (body && ws.canDrop(tab, target)) {
      const half = (body.width - INSET * 3) / 2;
      return { target, indicator: { left: body.left + INSET * 2 + half, top: body.top + INSET, width: half, height: body.height - INSET * 2 } };
    }
  }
  for (const el of groups) {
    const group = el.dataset.dockGroup;
    const body = el.querySelector<HTMLElement>("[data-dock-body]")?.getBoundingClientRect();
    if (!group || !body || x < body.left || x > body.right || y < body.top || y > body.bottom) continue;
    const rel = (x - body.left) / body.width;
    const side = rel < EDGE ? "left" : rel > 1 - EDGE ? "right" : null;
    const half = (body.width - INSET * 3) / 2;
    if (side) {
      const target: DropTarget = { kind: "split", group, side };
      if (ws.canDrop(tab, target))
        return {
          target,
          indicator: {
            left: side === "left" ? body.left + INSET : body.left + INSET * 2 + half,
            top: body.top + INSET,
            width: half,
            height: body.height - INSET * 2,
          },
        };
    }
    const into: DropTarget = { kind: "into", group };
    if (!ws.canDrop(tab, into)) return null;
    return { target: into, indicator: { left: body.left + INSET, top: body.top + INSET, width: body.width - INSET * 2, height: body.height - INSET * 2 } };
  }
  return null;
}

/** What a press on a tab read from its pointer event, before this chunk was loaded. */
export type Press = { wrapper: HTMLElement; startX: number; startY: number; pointerId: number; touch: boolean; pressedAt: number };

/**
 * Starts tracking a press on a tab. Nothing changes until the pointer moves past the threshold (or, for touch, after
 * a 250ms hold). Then, inside its own strip, the tab follows the pointer (clamped to the strip) and its neighbours
 * slide out of the way as its centre passes theirs; pulled 24px off the strip it detaches into a chip; over another
 * strip a gap opens where it would land; over a group body the split / move zone shows. Release drops; Esc, a lost
 * pointer or a release over nothing returns the tab to its slot.
 */
export function trackPress(p: Press, ws: WorkspaceValue, tab: TabId, label: string) {
  const { wrapper, startX, startY, pointerId, touch, pressedAt } = p;
  let own = wrapper.getBoundingClientRect();
  let grab = startX - own.left;
  const pinnedTab = wrapper.dataset.pinned !== undefined;
  let snaps: StripSnap[] = [];
  let from: { group: string; index: number } | null = null;
  let dragging = false;
  const body = document.body.style;

  const update = (x: number, y: number) => {
    const source = snaps.find((s) => s.group === from?.group);
    const fromGroup = from?.group ?? "";
    const fromIndex = from?.index ?? -1;
    const base = { tab, label, x, y, fromGroup, fromIndex, width: own.width };
    const left = x - grab;
    // Inside its own strip (anywhere along it, the tools included) the tab stays attached, clamped to the tab list.
    const attached = !!source && y >= source.strip.top - DETACH && y <= source.strip.bottom + DETACH && x >= source.strip.left && x <= source.strip.right;
    const over = attached ? source : snaps.find((s) => x >= s.strip.left && x <= s.strip.right && y >= s.strip.top && y <= s.strip.bottom);
    if (over) {
      const mine = over.group === fromGroup;
      const shown = clampLeft(left, own.width, over.list.left, over.list.right);
      // The slot follows the pointer, not the clamped drawing: the list now ends at its last tab (the "+" follows it,
      // decision 25), so a clamped centre could never pass the last tab's centre.
      const center = left + own.width / 2;
      // The pinned Orchestrator tab never leaves first place; nothing goes before it.
      const index = pinnedTab ? 0 : insertionIndex(over.slots, mine ? fromIndex : -1, center, over.pinned);
      const target: DropTarget = { kind: "strip", group: over.group, index: mine ? toMoveIndex(fromIndex, index) : index };
      const ok = ws.canDrop(tab, target);
      const dx = attached ? shown - own.left : 0;
      return setDrag({ ...base, attached, dx, slot: ok ? { group: over.group, index } : null, target: ok ? target : null, indicator: null });
    }
    const hit = bodyHit(ws, tab, x, y);
    setDrag({ ...base, attached: false, dx: 0, slot: null, target: hit?.target ?? null, indicator: hit?.indicator ?? null });
  };
  const begin = () => {
    dragging = true;
    snaps = snapshot();
    const before = own;
    own = wrapper.getBoundingClientRect();
    grab = Math.max(4, Math.min(own.width - 4, grab + (before.left - own.left)));
    const group = wrapper.closest<HTMLElement>("[data-dock-group]")?.dataset.dockGroup ?? "";
    const index = [...(wrapper.parentElement?.querySelectorAll("[data-tab-wrapper]") ?? [])].indexOf(wrapper);
    from = { group, index };
    body.cursor = "grabbing";
    body.userSelect = "none";
    // Tooltips stay hidden while a tab is dragged (styles.css).
    document.documentElement.dataset.dragging = "";
    window.getSelection()?.removeAllRanges();
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!dragging) {
      const far = Math.hypot(ev.clientX - startX, ev.clientY - startY) >= THRESHOLD;
      if (!far) return;
      // Touch: a move before the hold is a scroll, not a drag.
      if (touch && performance.now() - pressedAt < TOUCH_HOLD_MS) return end(false);
      begin();
    }
    ev.preventDefault();
    update(ev.clientX, ev.clientY);
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    body.cursor = "";
    body.userSelect = "";
    delete document.documentElement.dataset.dragging;
    const last = getDrag();
    const target = drop ? last?.target : null;
    // The tab settles from where it was drawn: 120ms into a new slot, 150ms back to its own.
    if (dragging && last?.attached) setSettle({ tab, left: own.left + last.dx, ms: target ? 120 : 150 });
    setDrag(null);
    if (dragging && target) ws.drop(tab, target);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) end(true);
  };
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
