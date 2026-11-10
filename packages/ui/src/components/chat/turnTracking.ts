import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNav } from "../../state/nav";

/** Distance from the scroll area's top at which a prompt counts as stuck (the sticky copy's inset). */
export const STICK_TOP = 8;

const TURN = "[data-turn-id]";
const PROMPT = "[data-prompt]";

function turnsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TURN)];
}

/**
 * Reports the request whose turn sits at the top of the conversation (IntersectionObserver on
 * a thin band under the top edge), so the sidebar can mark it. `key` changes when turns are added.
 */
export function useViewTurn(root: RefObject<HTMLElement | null>, projectId: string, enabled: boolean, key: unknown) {
  const nav = useNav();
  useEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    const visible = new Map<Element, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target, e.isIntersecting);
        const top = turnsIn(el).find((s) => visible.get(s));
        if (top) nav.setViewTurn({ projectId, messageId: Number(top.dataset.turnId) });
      },
      { root: el, rootMargin: `-${STICK_TOP}px 0px -70% 0px` },
    );
    for (const s of turnsIn(el)) io.observe(s);
    return () => io.disconnect();
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
      if (turns[mid].getBoundingClientRect().bottom <= covered) lo = mid + 1;
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
  reveal?: () => void;
}) {
  const nav = useNav();
  const { root, projectId, enabled, loaded, release } = opts;
  const revealRef = useRef(opts.reveal);
  useLayoutEffect(() => {
    revealRef.current = opts.reveal;
  });

  const scrollTo = useCallback(
    (messageId: number) => {
      const el = root.current;
      const turn = el?.querySelector<HTMLElement>(`[data-turn-id="${messageId}"]`);
      if (!el || !turn) return;
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
      window.setTimeout(() => prompt.removeAttribute("data-flash"), 1600);
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
  }, [enabled, loaded, nav, projectId, scrollTo]);
}
