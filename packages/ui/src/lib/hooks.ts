import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CLOCK_IDLE_MS, COPY_FEEDBACK_MS, NOW_ACTIVE_MS } from "./constants";
import { clockNow, onClockOffset } from "./clock";
import { isScrollKey, stickDecision } from "./stickDecision";

/**
 * A ref that always holds the latest `value`, updated in a layout effect (after the commit, before any event or effect can
 * read it). For callbacks and effects that must see current props or state without re-subscribing.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * A clock that ticks every `intervalMs` while `active`, and once a minute otherwise. The value is
 * stable between ticks, so memoised children that take it (the transcript) don't re-render on
 * unrelated updates such as scrolling.
 */
export function useNow(active: boolean, intervalMs = NOW_ACTIVE_MS, paused = false): number {
  // The service's clock (P2-12): times it stamped are compared with it, not with a machine clock that is off.
  const [now, setNow] = useState(clockNow);
  useEffect(() => {
    // Paused (a hidden tab or page): no timer at all; the clock catches up when it shows again.
    if (paused) return;
    setNow(clockNow());
    const tick = () => setNow(clockNow());
    const id = window.setInterval(tick, active ? intervalMs : CLOCK_IDLE_MS);
    const off = onClockOffset(tick);
    return () => {
      window.clearInterval(id);
      off();
    };
  }, [active, intervalMs, paused]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Further than this from the end, something is cut off below: the reader is no longer at the end. */
const END_TOLERANCE = 2;

/**
 * Follows new content while the reader is at the end. "At the end" is strict (nothing hidden below, 2px
 * tolerance): a reader who stopped a few lines short always gets Jump to latest, and the last line is
 * never left under the composer. A view hidden by its tab (display: none) keeps its intent: shown again,
 * it returns to the end. Scroll events of the smooth Jump-to-latest animation are not the reader's.
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[], initialStick = true) {
  const ref = useRef<T>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(initialStick);
  const hidden = useRef(false);
  const gliding = useRef(false);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  // The end the smooth glide is aimed at. Separate from `lastHeight`: a scroll event of the glide can read the grown
  // height before the ResizeObserver does, and the growth must still re-aim the glide (scroll-on-send.mjs).
  const glideEnd = useRef(0);
  // The reader has scrolled away themselves: only then does the first render's guess (agent not loaded yet) stop mattering.
  const touched = useRef(false);
  // The reader's own input inside the scroller (stickDecision): when it last happened, and whether a pointer is held on it
  // (dragging the scrollbar, middle-button autoscroll).
  const lastInput = useRef(Number.NEGATIVE_INFINITY);
  const pointerHeld = useRef(false);
  useEffect(() => {
    const inside = (e: Event) => e.target instanceof Node && !!ref.current?.contains(e.target);
    const stopGlide = () => {
      if (!gliding.current) return;
      gliding.current = false;
      const el = ref.current;
      if (el) el.scrollTo({ top: el.scrollTop, behavior: "auto" });
    };
    const mark = (e: Event) => {
      if (!inside(e)) return;
      lastInput.current = performance.now();
      if (e.type !== "touchend" && e.type !== "beforematch") stopGlide();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      // Keys typed into a text field move its caret, not the conversation (Alt+↑/↓ jumps release by themselves).
      const typing = t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement);
      if (!typing && isScrollKey(e.key)) {
        lastInput.current = performance.now();
        stopGlide();
      }
    };
    const onDown = (e: PointerEvent) => {
      // The scrollbar is the scroller itself; the middle button starts autoscroll anywhere in it.
      if (!inside(e) || (e.target !== ref.current && e.button !== 1)) return;
      pointerHeld.current = true;
      lastInput.current = performance.now();
      stopGlide();
    };
    const onUp = () => {
      if (pointerHeld.current) lastInput.current = performance.now();
      pointerHeld.current = false;
    };
    // The browser's find selects its match (window.find) or reveals hidden text (beforematch) before it scrolls there.
    const onSelection = () => {
      const s = document.getSelection();
      const node = s && !s.isCollapsed ? s.anchorNode : null;
      if (node && ref.current?.contains(node)) lastInput.current = performance.now();
    };
    const opts = { capture: true, passive: true } as const;
    const events = ["wheel", "touchstart", "touchmove", "touchend", "beforematch"] as const;
    for (const name of events) document.addEventListener(name, mark, opts);
    document.addEventListener("keydown", onKey, opts);
    document.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onUp, opts);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      for (const name of events) document.removeEventListener(name, mark, opts);
      document.removeEventListener("keydown", onKey, opts);
      document.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onUp, opts);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    // Scroll events from hiding/showing the tab (scrollTop reset) say nothing about the reader.
    if (!el || hidden.current || el.clientHeight === 0) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight <= END_TOLERANCE;
    // Content that got shorter (Markdown replacing plain text, a card resolving) clamps scrollTop: not the reader going up.
    const shrank = el.scrollHeight < lastHeight.current - 1;
    lastHeight.current = el.scrollHeight;
    const distance = lastTop.current - el.scrollTop;
    const movedUp = !shrank && distance > 1;
    lastTop.current = el.scrollTop;
    if (gliding.current) {
      if (end) {
        gliding.current = false;
      } else if (movedUp && (pointerHeld.current || performance.now() - lastInput.current <= 1000)) {
        gliding.current = false;
      } else {
        return;
      }
    }
    // A reflow (the group resized, a tab moved, WebKit re-anchoring) that leaves a following reader short of the end is
    // not the reader scrolling away: only the reader scrolling up lets go.
    const held = pointerHeld.current;
    const decision = stickDecision({
      end,
      following: atBottomRef.current,
      movedUp,
      distance,
      page: el.clientHeight,
      sinceInput: held ? 0 : performance.now() - lastInput.current,
    });
    // Within the tolerance but short of the very end (WebKit can leave a following view a pixel short): to the end, so the
    // composer growing later moves the column by exactly its own growth (flicker.mjs).
    if (decision === "repin" || (end && atBottomRef.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 1)) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      if (decision === "repin") return;
    }
    if (movedUp && !end) touched.current = true;
    atBottomRef.current = end;
    setAtBottom(end);
  }, []);

  /** Back to the end if the reader was following (a hidden tab shown again). */
  const restick = useCallback(() => {
    const el = ref.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    setAtBottom(true);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
    const animate = smooth && !reduced;
    // A long way to go: jump to a screenful above the end and glide only that, so the glide is short (it ends before
    // more content arrives, and a loaded machine does not leave it halfway).
    if (animate && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight) el.scrollTop = el.scrollHeight - 2 * el.clientHeight;
    gliding.current = animate;
    glideEnd.current = el.scrollHeight;
    el.scrollTo({ top: el.scrollHeight, behavior: animate ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  /** Stop following new content (before a programmatic scroll elsewhere). */
  const release = useCallback(() => {
    gliding.current = false;
    atBottomRef.current = false;
    setAtBottom(false);
  }, []);

  // `initialStick` can change after the first render (the agent record arrives): follow it until the reader has moved.
  useLayoutEffect(() => {
    if (!touched.current) atBottomRef.current = initialStick;
  }, [initialStick]);

  useLayoutEffect(() => {
    if (atBottomRef.current && !gliding.current) scrollToBottom(false);
  }, deps);

  // Reflow (a group resized, a prompt expanded, the composer shrank) keeps a reader at the bottom there;
  // coming back from hidden (the tab was in the background while the turn went on) returns to the end.
  const observed = useRef<{ el: Element; child: Element | null; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    const el = ref.current;
    // The content wrapper can be replaced under the same scroller (loading state → transcript): observe the current one.
    if (observed.current?.el === el && observed.current.child === el.firstElementChild) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        hidden.current = true;
        return;
      }
      const wasHidden = hidden.current;
      hidden.current = false;
      if (atBottomRef.current) {
        if (gliding.current && !wasHidden) {
          if (Math.abs(el.scrollHeight - glideEnd.current) > 1) {
            glideEnd.current = el.scrollHeight;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }
        } else {
          gliding.current = false;
          el.scrollTop = el.scrollHeight;
        }
        lastHeight.current = el.scrollHeight;
        if (wasHidden) setAtBottom(true);
      }
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    observed.current = { el, child: el.firstElementChild, ro };
  });
  useEffect(
    () => () => {
      // Cleared too: a remount (React strict mode, a kept-alive tab) must observe again, not trust a disconnected observer.
      observed.current?.ro.disconnect();
      observed.current = null;
    },
    [],
  );

  return { ref, atBottom, onScroll, scrollToBottom, release, restick };
}

export function useCopy(timeoutMs = COPY_FEEDBACK_MS): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), timeoutMs);
        },
        () => undefined,
      );
    },
    [timeoutMs],
  );
  return [copied, copy];
}

/** Calls `onEscape` for Escape presses that nothing inside the page already handled. */
export function useEscape(active: boolean, onEscape: () => void) {
  const handler = useLatest(onEscape);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) handler.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, handler]);
}

/**
 * Fades whichever end of a scroller has more content (`data-fade="start end"`, styled by the `fade-x` /
 * `fade-y` utilities): the cue for lists whose scrollbar is hidden so their rows keep the panel's insets.
 * Returns an updater to call after programmatic scrolls.
 */
export function useScrollFade<T extends HTMLElement>(ref: RefObject<T | null>, axis: "x" | "y"): () => void {
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const [pos, size, total] = axis === "x" ? [el.scrollLeft, el.clientWidth, el.scrollWidth] : [el.scrollTop, el.clientHeight, el.scrollHeight];
    const fade = [pos > 1 && "start", pos + size < total - 1 && "end"].filter(Boolean).join(" ");
    if ((el.dataset.fade ?? "") !== fade) el.dataset.fade = fade;
  }, [ref, axis]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, update]);
  return update;
}
