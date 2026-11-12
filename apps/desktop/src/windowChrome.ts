import type { WindowChrome } from "@octo/ui";

/** Width the macOS traffic lights take at the start of the title bar row (decision 54). */
export const MAC_INSET_START = 78;

/**
 * Where the macOS traffic lights go, in points from the window's top-left corner: the first light's left edge (`x`) and the
 * value given to `trafficLightPosition` in `src-tauri/tauri.macos.conf.json` (a test keeps the two equal).
 *
 * tao (0.37.2, `platform_impl/macos/view.rs` `inset_traffic_lights`) does not place the buttons at `y`: it resizes the title bar
 * container to `button height + y`, anchored at the window top, and leaves the buttons at their offset inside it. The lights'
 * centre is therefore `y + (button height / 2 - button offset from the container's bottom)`, a constant that depends on the macOS
 * version. Measured on the owner's 2x screenshot: `y: 14` gave a centre of about 11 pt, so that constant is about -3 and
 * `y: 23` puts the centre on the row's centre line (20). `OCTO_DEBUG_CHROME=1` draws the guide to check it.
 */
export const MAC_LIGHTS_X = 16;
export const MAC_LIGHTS_Y = 23;

/** The centre line the lights are placed on and the title row's controls align to: the middle of the 40 pt row. */
export const MAC_CONTROLS_CENTER_Y = 20;

/**
 * The frame the UI's title bar row has to fit. Only the macOS window (the Tauri config gives it `titleBarStyle: "Overlay"`)
 * hides the native title bar: the row then sits under the traffic lights and keeps `MAC_INSET_START` free. Full screen has no
 * traffic lights, so no inset. Windows, Linux and a browser keep their own frame: nothing to reserve.
 */
export function chromeFor(tauri: boolean, userAgent: string, fullscreen: boolean): WindowChrome {
  const mac = tauri && /Macintosh|Mac OS X/.test(userAgent);
  if (!mac) return { overlay: false, insetStart: 0, insetEnd: 0 };
  return { overlay: true, insetStart: fullscreen ? 0 : MAC_INSET_START, insetEnd: 0, controlsCenterY: MAC_CONTROLS_CENTER_Y };
}

/** The part of the DOM API `isDragTarget` needs (so a test can pass a fake). */
type Closest = { closest(selector: string): unknown };

const CONTROLS = 'button, a, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

/** A press starts a window drag when it lands in a `data-drag-region` (set by `packages/ui`) and not on a control inside it. */
export function isDragTarget(target: Closest | null): boolean {
  return target !== null && target.closest("[data-drag-region]") !== null && target.closest(CONTROLS) === null;
}

/** What the shell reports for `OCTO_DEBUG_CHROME=1` (`chrome_debug` command in `src-tauri/src/lib.rs`). */
export type ChromeDebug = { enabled: boolean; configuredX: number | null; configuredY: number | null };

/** The line the debug aid logs: configured position, the centre it should give, and what the UI aligns to. */
export function describeChrome(d: ChromeDebug, chrome: WindowChrome): string {
  const cfg = d.configuredY === null ? "none (system default, centre about 14 pt)" : `x=${d.configuredX} y=${d.configuredY}`;
  return `octo chrome: trafficLightPosition ${cfg}; row controls centre ${chrome.controlsCenterY ?? 20} pt; insetStart ${chrome.insetStart}`;
}
