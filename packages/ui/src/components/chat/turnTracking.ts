import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useNav } from "../../state/nav";
import { PROMPT_FLASH_MS } from "../../lib/constants";
import { useLatest } from "../../lib/hooks";
import { revealTurn } from "./turnReveal";

/** Distance from the scroll area's top at which a prompt counts as stuck (the sticky copy's inset). */
export const STICK_TOP = 8;

const TURN = "[data-turn-id]";
const PROMPT = "[data-prompt]";

function turnsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TURN)];
}

/**
 * Reports the request in view (the rail marks it): the newest request whose prompt box is fully visible, else the
 * turn that reaches the band under the top edge. So after sending, the new request is the one in view as soon as its
 * prompt shows, even while the previous turn still fills the top (v6.1 review). `key` changes when turns are added.
 */
export function useViewTurn(root: RefObject<HTMLElement | null>, projectId: string, enabled: boolean, key: unknown) {
  const nav = useNav();
  useEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      if (box.height === 0) return;
      const turns = turnsIn(el);
      let chosen: HTMLElement | undefined;
      for (let i = turns.length - 1; i >= 0; i--) {
        const prompt = turns[i]?.querySelector(PROMPT)?.getBoundingClientRect();
        if (prompt && prompt.top >= box.top && prompt.bottom <= box.bottom) {
          chosen = turns[i];
          break;
        }
      }
      chosen ??= turns.find((s) => s.getBoundingClientRect().bottom > box.top + STICK_TOP);
      if (chosen) nav.setViewTurn({ projectId, messageId: Number(chosen.dataset.turnId) });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const t of turnsIn(el)) ro.observe(t);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [root, projectId, enabled, key, nav]);

  useEffect(() => () => nav.setViewTurn(null), [nav]);
}

/** Height the pinned copy is assumed to take before it has been measured (3 lines + insets + fade). */
const PINNED_ESTIMATE = 128;

/**
 * The turn whose prompt has scrolled out above the top edge while the turn is still being read.
 * Pinning never shows two prompt boxes: a prompt pins only once its in-flow box is entirely above
 * the scroll area, and the pinned copy (its height incl. the fade is reported through
 * `setPinnedHeight`) gives way as soon as the next turn's prompt would slide under it.
 */
export function useStuckTurn(root: RefObject<HTMLElement | null>): { stuckId: number | null; onScroll(): void; setPinnedHeight(px: number): void } {
  const [stuckId, setStuckId] = useState<number | null>(null);
  const frame = useRef(0);
  const pinned = useRef(PINNED_ESTIMATE);

  const measure = useCallback(() => {
    frame.current = 0;
    const el = root.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // The pinned copy covers [top, top + pinned): a turn ending inside it is done being read.
    const covered = top + pinned.current;
    let next: number | null = null;
    // Turns are in document order: binary-search the first one still reaching below the covered band.
    const turns = turnsIn(el);
    let lo = 0;
    let hi = turns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((turns[mid]?.getBoundingClientRect().bottom ?? Infinity) <= covered) lo = mid + 1;
      else hi = mid;
    }
    const s = turns[lo];
    if (s && s.getBoundingClientRect().top < top) {
      const prompt = s.querySelector(PROMPT);
      if (prompt && prompt.getBoundingClientRect().bottom <= top) next = Number(s.dataset.turnId);
    }
    setStuckId(next);
  }, [root]);

  const onScroll = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
  }, [measure]);

  const setPinnedHeight = useCallback(
    (px: number) => {
      if (Math.abs(px - pinned.current) < 1) return;
      pinned.current = px;
      onScroll();
    },
    [onScroll],
  );

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  return { stuckId, onScroll, setPinnedHeight };
}

/**
 * Scrolls to requests the sidebar or palette asked for: a pending one once messages have loaded,
 * and new ones while this conversation is open. The prompt lands just below the top edge and
 * briefly carries `data-flash`.
 */
export function useTurnRequests(opts: {
  root: RefObject<HTMLElement | null>;
  projectId: string;
  enabled: boolean;
  loaded: boolean;
  release(): void;
  /** Brings this conversation's tab to the front first (it may be hidden behind another tab). */
  reveal?: (() => void) | undefined;
}) {
  const nav = useNav();
  const { root, projectId, enabled, loaded, release } = opts;
  const revealRef = useLatest(opts.reveal);

  const scrollTo = useCallback(
    (messageId: number) => {
      const el = root.current;
      const turn = el?.querySelector<HTMLElement>(`[data-turn-id="${messageId}"]`);
      if (!el || !turn) return;
      // A far turn is an empty section until mounted (stress P1-6): mount it first, then measure its prompt.
      revealTurn(turn);
      const prompt = turn.querySelector<HTMLElement>(PROMPT) ?? turn;
      // A time separator above the prompt lands in view with it.
      const anchor = turn.querySelector<HTMLElement>("[data-time-sep]") ?? prompt;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      release();
      const top = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 2 * STICK_TOP;
      // Glide over short distances only: further than two screens, jump (a long glide reads as lag).
      const far = Math.abs(top - el.scrollTop) > 2 * el.clientHeight;
      el.scrollTo({ top, behavior: reduced || far ? "auto" : "smooth" });
      prompt.setAttribute("data-flash", "");
      window.setTimeout(() => prompt.removeAttribute("data-flash"), PROMPT_FLASH_MS);
    },
    [root, release],
  );

  useEffect(() => {
    if (!enabled || !loaded) return;
    // A hidden tab has no layout to scroll: show it, then scroll once it has been laid out.
    const go = (messageId: number) => {
      revealRef.current?.();
      requestAnimationFrame(() => requestAnimationFrame(() => scrollTo(messageId)));
    };
    const pending = nav.takePendingTurn(projectId);
    if (pending) go(pending.messageId);
    return nav.onTurnRequest((turn) => {
      if (turn.projectId !== projectId) return;
      nav.takePendingTurn(projectId);
      go(turn.messageId);
    });
  }, [enabled, loaded, nav, projectId, scrollTo, revealRef]);
}
