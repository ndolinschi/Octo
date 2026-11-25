import type { WindowChrome } from "@octo/ui";

/** The sidebar's glyph column: its rows' leading 16px slot starts 24 px from the window's edge (gutter 8 + pane 8 + row inset 8); `TitleBar` aligns the toggle to it with no lights. */
export const SIDEBAR_GLYPH_X = 24;
/** The gap between the bar's own buttons (the toggle, back and forward are 28 px boxes, 4 px apart). */
export const BAR_BUTTON_GAP = 4;

/**
 * The macOS traffic lights as measured on the owner's 2x screenshot (macOS 26 drawing): 12 pt discs, 23 pt between centres (macOS 15
 * and older: 20 pt). The browser preview draws them at these sizes; the test derives the inset from them.
 */
export const MAC_LIGHT_SIZE = 12;
export const MAC_LIGHT_PITCH = 23;

/**
 * Where the macOS traffic lights go, in points from the window's top-left corner: the first light's left edge (`x`) and the
 * value given to `trafficLightPosition` in `src-tauri/tauri.macos.conf.json` (a test keeps the two equal).
 *
 * `x` is the sidebar's glyph column (`SIDEBAR_GLYPH_X`): the red light's centre then sits 2 pt from the Home / Search / Review
 * glyph centres, so lights, nav glyphs and the status-bar glyph read as one column (at 16 pt, the row boxes' edge, the lights
 * sat 9 pt left of the glyphs; owner: "not aligned with buttons in left sidebar").
 *
 * tao (0.37.2, `platform_impl/macos/view.rs` `inset_traffic_lights`) does not place the buttons at `y`: it resizes the title bar
 * container to `button height + y`, anchored at the window top, and leaves the buttons at their offset inside it. The lights'
 * centre is therefore `y + MAC_LIGHTS_CENTER_OFFSET`, a constant that depends on the macOS version. Measured on the owner's 2x
 * screenshot (scale 1.086 px per pt, from the 260 pt sidebar + 8 pt gutter and the 32 pt toggle-to-forward pitch): at `y: 23`
 * the lights' centre was 0.9 pt below the bar buttons' centre, so the offset is -2 and `y: 22` puts it on the centre line (20).
 * `OCTO_DEBUG_CHROME=1` draws the guide to check it.
 */
export const MAC_LIGHTS_X = SIDEBAR_GLYPH_X;
export const MAC_LIGHTS_Y = 22;
export const MAC_LIGHTS_CENTER_OFFSET = -2;

/** The centre line the lights are placed on and the title row's controls align to: the middle of the 40 pt row. */
export const MAC_CONTROLS_CENTER_Y = 20;

/**
 * What the traffic lights take at the start of the title bar row: the lights (`x`, two pitches, one disc) plus the bar's own button
 * gap before the first control (decision 54; the lights' right edge to the toggle's box is 4 pt, like toggle to back).
 */
export const MAC_INSET_START = MAC_LIGHTS_X + 2 * MAC_LIGHT_PITCH + MAC_LIGHT_SIZE + BAR_BUTTON_GAP;

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

/** Dev only (`?titlebar=mac`, `?titlebar=mac-fullscreen`): the browser pretends to be the macOS shell. The caller guards it with `import.meta.env.DEV`. */
export function macPreview(search: string): "mac" | "mac-fullscreen" | null {
  const v = new URLSearchParams(search).get("titlebar");
  return v === "mac" || v === "mac-fullscreen" ? v : null;
}

export const PREVIEW_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
