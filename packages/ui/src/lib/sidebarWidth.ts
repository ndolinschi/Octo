import { useLayoutEffect, useRef, type RefObject } from "react";
import { numberCodec, PREFS, usePersistentState } from "./storage";

/**
 * The sidebar's width (shell polish, item 3): a layout preference the person sets by dragging the sidebar's edge (decision 79:
 * a pane's width comes from layout state, never from its content). The Settings page's column takes the same width.
 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
/** The `--spacing-sidebar` token's value (`styles.css`). */
export const SIDEBAR_DEFAULT = 260;

export const clampSidebar = (px: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));

const codec = numberCodec(SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT);

/**
 * The stored width, applied to `ref`'s element as `--spacing-sidebar` (what its `w-sidebar` reads). `preview` sets a width on
 * the element alone, in the next frame and without a React render (a drag: the transcript beside it must not re-render per
 * pointer move); `commit` stores one.
 */
export function useSidebarWidth(ref: RefObject<HTMLElement | null>): { width: number; preview(px: number): void; commit(px: number): void } {
  const [width, setWidth] = usePersistentState(PREFS.sidebarWidth, codec, { persistInitial: false });
  const frame = useRef(0);
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--spacing-sidebar", `${width}px`);
  }, [ref, width]);
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
  const preview = (px: number) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => ref.current?.style.setProperty("--spacing-sidebar", `${clampSidebar(px)}px`));
  };
  const commit = (px: number) => {
    cancelAnimationFrame(frame.current);
    const next = clampSidebar(px);
    ref.current?.style.setProperty("--spacing-sidebar", `${next}px`);
    setWidth(next);
  };
  return { width, preview, commit };
}
