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

/** The turn whose prompt has scrolled under the top edge while the turn is still being read. */
export function useStuckTurn(root: RefObject<HTMLElement | null>): { stuckId: number | null; onScroll(): void } {
  const [stuckId, setStuckId] = useState<number | null>(null);
  const frame = useRef(0);

  const measure = useCallback(() => {
    frame.current = 0;
    const el = root.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + STICK_TOP;
    let next: number | null = null;
    // Turns are in document order: binary-search the first one still reaching below the line.
    const turns = turnsIn(el);
    let lo = 0;
    let hi = turns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid].getBoundingClientRect().bottom <= top + 40) lo = mid + 1;
      else hi = mid;
    }
    const s = turns[lo];
    if (s && s.getBoundingClientRect().top <= top) {
      const prompt = s.querySelector(PROMPT);
      if (prompt && prompt.getBoundingClientRect().top < top) next = Number(s.dataset.turnId);
    }
    setStuckId(next);
  }, [root]);

  const onScroll = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  return { stuckId, onScroll };
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
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      release();
      const top = prompt.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 2 * STICK_TOP;
      el.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
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
