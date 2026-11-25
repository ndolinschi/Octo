import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BAR_BUTTON_GAP,
  chromeFor,
  describeChrome,
  isDragTarget,
  MAC_CONTROLS_CENTER_Y,
  MAC_INSET_START,
  MAC_LIGHT_PITCH,
  MAC_LIGHT_SIZE,
  MAC_LIGHTS_CENTER_OFFSET,
  MAC_LIGHTS_X,
  MAC_LIGHTS_Y,
  macPreview,
  SIDEBAR_GLYPH_X,
} from "./windowChrome";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";

test("only the macOS app overlays the title bar and reserves the traffic lights", () => {
  assert.deepEqual(chromeFor(true, MAC, false), { overlay: true, insetStart: MAC_INSET_START, insetEnd: 0, controlsCenterY: MAC_CONTROLS_CENTER_Y });
  assert.deepEqual(chromeFor(true, LINUX, false), { overlay: false, insetStart: 0, insetEnd: 0 });
  assert.deepEqual(chromeFor(false, MAC, false), { overlay: false, insetStart: 0, insetEnd: 0 });
});

test("full screen has no traffic lights, so no inset", () => {
  assert.deepEqual(chromeFor(true, MAC, true), { overlay: true, insetStart: 0, insetEnd: 0, controlsCenterY: MAC_CONTROLS_CENTER_Y });
});

const el = (matches: string[]) => ({ closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null) });

test("a press in a drag region drags; on a control inside it, it does not", () => {
  assert.equal(isDragTarget(el(["[data-drag-region]"])), true);
  assert.equal(isDragTarget(el(["[data-drag-region]", "button"])), false);
  assert.equal(isDragTarget(el([])), false);
  assert.equal(isDragTarget(null), false);
});

test("the macOS window config places the lights where the chrome says", () => {
  type Conf = { app: { windows: Record<string, unknown>[] } };
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../src-tauri/${f}`, import.meta.url), "utf8")) as Conf;
  const conf = read("tauri.macos.conf.json");
  const base = read("tauri.conf.json");
  const win = conf.app.windows[0] ?? {};
  assert.deepEqual(win.trafficLightPosition, { x: MAC_LIGHTS_X, y: MAC_LIGHTS_Y });
  assert.equal(win.titleBarStyle, "Overlay");
  // The merge replaces the windows array: the platform window must repeat every field of the base window, same label.
  for (const [k, v] of Object.entries(base.app.windows[0] ?? {})) assert.deepEqual(win[k], v, k);
  assert.equal(MAC_CONTROLS_CENTER_Y, 20);
  assert.equal(MAC_LIGHTS_X, SIDEBAR_GLYPH_X, "the red light starts on the sidebar's glyph column");
  assert.equal(MAC_LIGHTS_Y + MAC_LIGHTS_CENTER_OFFSET, MAC_CONTROLS_CENTER_Y, "the lights' centre is the bar buttons' centre");
  const greenRight = MAC_LIGHTS_X + 2 * MAC_LIGHT_PITCH + MAC_LIGHT_SIZE;
  assert.equal(MAC_INSET_START - greenRight, BAR_BUTTON_GAP, "green light to the toggle is the bar's own button gap");
  assert.equal(MAC_INSET_START, 86);
});

test("the debug line names the configured and the effective values", () => {
  const chrome = chromeFor(true, MAC, false);
  assert.equal(
    describeChrome({ enabled: true, configuredX: 16, configuredY: 23 }, chrome),
    "octo chrome: trafficLightPosition x=16 y=23; row controls centre 20 pt; insetStart 86",
  );
  assert.equal(describeChrome({ enabled: true, configuredX: null, configuredY: null }, chrome).split("system default").length, 2);
});

test("the browser preview knob is only the two known values", () => {
  assert.equal(macPreview("?demo=1&titlebar=mac"), "mac");
  assert.equal(macPreview("?titlebar=mac-fullscreen"), "mac-fullscreen");
  assert.equal(macPreview("?titlebar=win"), null);
  assert.equal(macPreview(""), null);
});
