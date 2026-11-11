import { useEffect, useState, type RefObject } from "react";
import { usePageVisible } from "../../lib/hooks";

/**
 * Decision 45: a work-in-progress effect pauses while the window is hidden or its element is off-screen (or in a
 * background tab, display: none). Returns true while it should be paused; the element carries `data-paused`.
 */
export function useAnimationGate(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const visible = usePageVisible();
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, active]);
  return !visible || !onScreen;
}

/** Decision 45 a: after a failed turn the edge drains to the danger colour once (this long), then rests. */
const DRAIN_MS = 1200;

export type AuroraState = "working" | "failed" | "off";

/** The composer edge: working while the turn runs; "failed" once, briefly, when it ends in failure. */
export function useAuroraState(running: boolean, failed: boolean): AuroraState {
  const [prev, setPrev] = useState({ running, failed });
  const [drain, setDrain] = useState(false);
  if (prev.running !== running || prev.failed !== failed) {
    setPrev({ running, failed });
    if (!running && failed && (prev.running || !prev.failed)) setDrain(true);
    if (running) setDrain(false);
  }
  useEffect(() => {
    if (!drain) return;
    const id = window.setTimeout(() => setDrain(false), DRAIN_MS);
    return () => window.clearTimeout(id);
  }, [drain]);
  return running ? "working" : drain ? "failed" : "off";
}
