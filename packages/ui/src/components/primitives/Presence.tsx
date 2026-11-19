import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MOTION_FAST_MS } from "../../lib/constants";

export type PresenceState = "open" | "closed";

const PresenceContext = createContext<PresenceState>("open");

/** Every overlay exit in styles.css is `--motion-fast`. */
const EXIT_MS = MOTION_FAST_MS;

/**
 * Keeps an overlay mounted for its exit animation. While `show` is false the last children stay
 * rendered for `exitMs` with `usePresence()` = "closed" (overlays set `data-state` and `inert` from
 * it), then unmount. Showing again during the exit simply re-opens.
 */
export function Presence({ show, children, exitMs = EXIT_MS }: { show: boolean; children: ReactNode; exitMs?: number }) {
  const last = useRef<ReactNode>(null);
  const [prevShow, setPrevShow] = useState(show);
  const [leaving, setLeaving] = useState(false);
  // Derived from the previous render's `show`, so the exit starts in the same render (no unmount gap).
  if (show !== prevShow) {
    setPrevShow(show);
    setLeaving(!show);
  }
  if (show) last.current = children;

  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => setLeaving(false), exitMs);
    return () => window.clearTimeout(id);
  }, [leaving, exitMs]);

  if (!show && !leaving) return null;
  return <PresenceContext.Provider value={show ? "open" : "closed"}>{show ? children : last.current}</PresenceContext.Provider>;
}

/** "closed" while the surrounding <Presence> plays an exit; "open" otherwise (also outside one). */
export function usePresence(): PresenceState {
  return useContext(PresenceContext);
}
