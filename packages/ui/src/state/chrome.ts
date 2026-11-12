import { createContext, useContext } from "react";

/**
 * The window frame the host draws around the UI (decision 54). `overlay`: the host hides its own title bar and the UI's
 * title bar row sits under the window controls; `insetStart` / `insetEnd`: pixels the row keeps free at its start and end
 * (macOS traffic lights: 78 at the start; Windows or Linux controls drawn by the app: at the end). The default is a browser:
 * no overlay, no insets; the row renders all the same. `controlsCenterY`: where the window controls' centre line is, in pixels
below the window's top edge; the row centres its controls on it (default: the row's own centre, `ROW_HEIGHT / 2`).
 */
export type WindowChrome = { overlay: boolean; insetStart: number; insetEnd: number; controlsCenterY?: number };

/** The title bar row's height (`--spacing-bar` in styles.css). */
export const ROW_HEIGHT = 40;

/**
 * Padding that moves the row's vertically centred content so its centre line sits on `centerY` (the row is a fixed-height flex
 * box with `items-center`: centre = (top + (ROW_HEIGHT - bottom)) / 2). No `centerY`, or the row's own centre: no padding.
 * The shift is limited to the row (a centre outside it would clip the controls).
 */
export function controlsPadding(centerY: number | undefined): { top: number; bottom: number } {
  if (centerY === undefined || !Number.isFinite(centerY)) return { top: 0, bottom: 0 };
  const half = ROW_HEIGHT / 2;
  const shift = Math.max(-half / 2, Math.min(half / 2, Math.round(centerY - half)));
  return shift >= 0 ? { top: 2 * shift, bottom: 0 } : { top: 0, bottom: -2 * shift };
}

/** The row's side padding when the host reserves nothing (the panels' 8px inset). */
export const SIDE_PAD = 8;
/** Sidebar toggle, back and forward: three 28px buttons, 4px apart. */
const CLUSTER_WIDTH = 3 * 28 + 2 * 4;
/** The 8px between that cluster and the first tab. */
const CLUSTER_GAP = 8;

/**
 * Where the first tab strip starts when the sidebar is closed (decision 67): after the window controls' inset and the
 * cluster of sidebar toggle and back / forward that float over the window's top-left corner.
 */
export function controlsWidth(insetStart: number): number {
  return Math.max(SIDE_PAD, insetStart) + CLUSTER_WIDTH + CLUSTER_GAP;
}

export const NO_CHROME: WindowChrome = { overlay: false, insetStart: 0, insetEnd: 0 };

const ChromeContext = createContext<WindowChrome>(NO_CHROME);

export const ChromeProvider = ChromeContext.Provider;

export function useChrome(): WindowChrome {
  return useContext(ChromeContext);
}
