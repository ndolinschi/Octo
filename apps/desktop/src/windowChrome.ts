import type { WindowChrome } from "@octo/ui";

/** Width the macOS traffic lights take at the start of the title bar row (decision 54). */
export const MAC_INSET_START = 78;

/**
 * The frame the UI's title bar row has to fit. Only the macOS window (the Tauri config gives it `titleBarStyle: "Overlay"`)
 * hides the native title bar: the row then sits under the traffic lights and keeps `MAC_INSET_START` free. Full screen has no
 * traffic lights, so no inset. Windows, Linux and a browser keep their own frame: nothing to reserve.
 */
export function chromeFor(tauri: boolean, userAgent: string, fullscreen: boolean): WindowChrome {
  const mac = tauri && /Macintosh|Mac OS X/.test(userAgent);
  if (!mac) return { overlay: false, insetStart: 0, insetEnd: 0 };
  return { overlay: true, insetStart: fullscreen ? 0 : MAC_INSET_START, insetEnd: 0 };
}

/** The part of the DOM API `isDragTarget` needs (so a test can pass a fake). */
type Closest = { closest(selector: string): unknown };

const CONTROLS = 'button, a, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

/** A press starts a window drag when it lands in a `data-drag-region` (set by `packages/ui`) and not on a control inside it. */
export function isDragTarget(target: Closest | null): boolean {
  return target !== null && target.closest("[data-drag-region]") !== null && target.closest(CONTROLS) === null;
}
