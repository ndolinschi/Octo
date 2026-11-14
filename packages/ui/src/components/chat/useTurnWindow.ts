import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { estimateTurnHeight, keysAround, MOUNT_MARGIN_PX, tailStart, UNMOUNT_MARGIN_PX } from "../../lib/turnWindow";
import { promptText, type Turn } from "../../lib/transcript";
import { useLatest } from "../../lib/hooks";
import { MOUNT_EVENT } from "./turnReveal";

/**
 * Stress P1-6: a long conversation mounts only the turns near the viewport. Every turn keeps its `<section data-turn-id>`
 * (the rail, the pinned prompt and the jumps find it), but a turn far from the viewport is an empty section of its remembered
 * height (or an estimate until it has been seen) holding its text `hidden="until-found"`, so the browser's find still reaches
 * it. Two IntersectionObservers on the scroller: one mounts what comes within `MOUNT_MARGIN_PX`, the other unmounts what
 * goes further than `UNMOUNT_MARGIN_PX` (never while the reader's selection is inside), so scrolling back and forth does not
 * remount. Mounting while scrolling is a transition: React renders it in slices between frames. The newest turns are always
 * mounted (`tailStart`).
 *
 * Protocol (`turnReveal.ts`, which the eager jump code imports without this module): `revealTurn(section)` mounts a turn
 * synchronously before a jump measures it.
 */

/** Measured heights by agent and turn, kept across remounts (a moved tab restores its scroll position over them). */
const measured = new Map<string, number>();
const estimates = new Map<string, { sig: string; h: number }>();

/**
 * What identifies a turn's content across `buildTurns` runs (each makes new turn objects, and one runs whenever a message
 * arrives): its key, item count, last item and end. Caches keyed by it survive a tool result landing mid-stream.
 */
export function turnSig(turn: Turn): string {
  return `${turn.items.length}:${turn.items[turn.items.length - 1]?.key ?? ""}:${turn.lastAt ?? ""}`;
}

function estimateOf(agentId: string, turn: Turn): number {
  const id = `${agentId}:${turn.key}`;
  const sig = turnSig(turn);
  const hit = estimates.get(id);
  if (hit?.sig === sig) return hit.h;
  {
    let reply = "";
    let tools = 0;
    for (const item of turn.items) {
      if (item.kind === "text") reply += `${item.text}\n\n`;
      else tools += 1;
    }
    const h = estimateTurnHeight(turn.prompt ? promptText(turn.prompt) : "", reply, tools);
    estimates.set(id, { sig, h });
    return h;
  }
}

/** WebKit has no CSS scroll anchoring: there a turn mounted above the viewport moves the scroll position by its change itself. */
const NATIVE_ANCHORING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
}

function selectionIn(el: Element): boolean {
  const s = document.getSelection();
  return !!s && !s.isCollapsed && s.rangeCount > 0 && s.getRangeAt(0).intersectsNode(el);
}

const keyOf = (el: Element) => (el instanceof HTMLElement ? el.dataset.turnKey : undefined);

export function useTurnWindow(agentId: string, turns: readonly Turn[], ready: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const io = useRef<IntersectionObserver[]>([]);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const keys = useMemo(() => turns.map((t) => t.key), [turns]);
  const keysRef = useLatest(keys);
  const heightAt = useCallback(
    (i: number) => {
      const turn = turns[i];
      return turn ? (measured.get(`${agentId}:${turn.key}`) ?? estimateOf(agentId, turn)) : 0;
    },
    [agentId, turns],
  );
  const tail = useMemo(
    () =>
      tailStart(
        turns.map((_, i) => heightAt(i)),
        typeof window === "undefined" ? 900 : window.innerHeight,
      ),
    [turns, heightAt],
  );
  /** Placeholders that just mounted above the viewport: their height then, for the scroll correction without native anchoring. */
  const grown = useRef<{ el: Element; before: number }[]>([]);

  const update = useCallback((add: readonly string[], drop: readonly string[]) => {
    setMounted((cur) => {
      if (add.every((k) => cur.has(k)) && drop.every((k) => !cur.has(k))) return cur;
      const next = new Set(cur);
      for (const k of add) next.add(k);
      for (const k of drop) next.delete(k);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const scroller = scrollParent(el);
    const near = new IntersectionObserver(
      (entries) => {
        const add: string[] = [];
        const top = scroller?.getBoundingClientRect().top ?? 0;
        for (const e of entries) {
          const key = keyOf(e.target);
          if (!key || !e.isIntersecting) continue;
          add.push(key);
          if (!NATIVE_ANCHORING && !e.target.hasAttribute("data-turn-mounted") && e.boundingClientRect.bottom <= top) {
            grown.current.push({ el: e.target, before: e.boundingClientRect.height });
          }
        }
        if (add.length) startTransition(() => update(add, []));
      },
      { root: scroller, rootMargin: `${MOUNT_MARGIN_PX}px 0px` },
    );
    // Far turns kept for the reader's selection: looked at again once the selection lets them go (observing anew reports them).
    const held = new Set<Element>();
    const onSelection = () => {
      for (const t of held) {
        if (selectionIn(t)) continue;
        held.delete(t);
        far.unobserve(t);
        far.observe(t);
      }
    };
    document.addEventListener("selectionchange", onSelection);
    const far = new IntersectionObserver(
      (entries) => {
        const drop: string[] = [];
        for (const e of entries) {
          const key = keyOf(e.target);
          // Dropped even if its mount has not committed yet (a fast scroll), or it would stay mounted out of sight.
          if (!key || e.isIntersecting) continue;
          if (selectionIn(e.target)) {
            held.add(e.target);
            continue;
          }
          if (e.target.hasAttribute("data-turn-mounted")) measured.set(`${agentId}:${key}`, e.boundingClientRect.height);
          drop.push(key);
        }
        if (drop.length) startTransition(() => update([], drop));
      },
      { root: scroller, rootMargin: `${UNMOUNT_MARGIN_PX}px 0px` },
    );
    io.current = [near, far];
    for (const s of el.querySelectorAll(":scope > section[data-turn-key]")) for (const o of io.current) o.observe(s);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      near.disconnect();
      far.disconnect();
      io.current = [];
    };
  }, [agentId, update]);

  // Without native anchoring, keep what the reader sees still when turns above it mount.
  useLayoutEffect(() => {
    const list = grown.current;
    if (!list.length || !root.current) return;
    grown.current = [];
    const scroller = scrollParent(root.current);
    if (!scroller) return;
    let delta = 0;
    for (const { el, before } of list) if (el.isConnected) delta += el.getBoundingClientRect().height - before;
    if (delta) scroller.scrollTop += delta;
  }, [mounted]);

  // A jump (`revealTurn`) or the browser's find (`beforematch` on the hidden text) mounts the turn now.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onReveal = (e: Event) => {
      const section = e.target instanceof Element ? e.target.closest("section[data-turn-key]") : null;
      const key = section ? keyOf(section) : undefined;
      const index = key === undefined ? -1 : keysRef.current.indexOf(key);
      if (index < 0) return;
      flushSync(() => update(keysAround(keysRef.current, index), []));
    };
    el.addEventListener(MOUNT_EVENT, onReveal);
    el.addEventListener("beforematch", onReveal);
    return () => {
      el.removeEventListener(MOUNT_EVENT, onReveal);
      el.removeEventListener("beforematch", onReveal);
    };
  }, [keysRef, update]);

  /** Ref for each turn's section: observed while it exists. */
  const observe = useCallback((section: HTMLElement | null) => {
    if (!section) return;
    for (const o of io.current) o.observe(section);
    return () => {
      for (const o of io.current) o.unobserve(section);
    };
  }, []);

  const isMounted = (i: number) => ready && (i >= tail || mounted.has(keys[i] ?? ""));
  return { root, observe, isMounted, heightAt };
}
