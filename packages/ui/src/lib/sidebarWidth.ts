import { useLayoutEffect, useState, type RefObject } from "react";
import { PREFS, readPref, writePref } from "./storage";

/**
 * The sidebar's width (shell polish, item 3): a layout preference the person sets by dragging the sidebar's edge (decision 79:
 * a pane's width comes from layout state, never from its content). The Settings page's column takes the same width.
 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
/** The `--spacing-sidebar` token's value (`styles.css`). */
export const SIDEBAR_DEFAULT = 260;

/** Within 200–480 and whole; anything that is not a number (nothing stored, foreign text) is the default. */
export const clampSidebar = (px: number): number =>
  Number.isFinite(px) && px > 0 ? Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px))) : SIDEBAR_DEFAULT;

/** Sets the width on the element (what its `w-sidebar` reads), without a React render. */
export const applySidebarWidth = (el: HTMLElement | null, px: number): void => el?.style.setProperty("--spacing-sidebar", `${clampSidebar(px)}px`);

/** The stored width, applied to `ref`'s element; `commit` stores a new one (the edge's drag previews with `applySidebarWidth`). */
export function useSidebarWidth(ref: RefObject<HTMLElement | null>): { width: number; commit(px: number): void } {
  const [width, setWidth] = useState(() => clampSidebar(Number(readPref(PREFS.sidebarWidth))));
  useLayoutEffect(() => applySidebarWidth(ref.current, width), [ref, width]);
  const commit = (px: number) => {
    const next = clampSidebar(px);
    applySidebarWidth(ref.current, next);
    writePref(PREFS.sidebarWidth, String(next));
    setWidth(next);
  };
  return { width, commit };
}
