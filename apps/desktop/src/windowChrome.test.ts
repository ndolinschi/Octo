import assert from "node:assert/strict";
import test from "node:test";
import { chromeFor, isDragTarget, MAC_INSET_START } from "./windowChrome";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";

test("only the macOS app overlays the title bar and reserves the traffic lights", () => {
  assert.deepEqual(chromeFor(true, MAC, false), { overlay: true, insetStart: MAC_INSET_START, insetEnd: 0 });
  assert.deepEqual(chromeFor(true, LINUX, false), { overlay: false, insetStart: 0, insetEnd: 0 });
  assert.deepEqual(chromeFor(false, MAC, false), { overlay: false, insetStart: 0, insetEnd: 0 });
});

test("full screen has no traffic lights, so no inset", () => {
  assert.deepEqual(chromeFor(true, MAC, true), { overlay: true, insetStart: 0, insetEnd: 0 });
});

const el = (matches: string[]) => ({ closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null) });

test("a press in a drag region drags; on a control inside it, it does not", () => {
  assert.equal(isDragTarget(el(["[data-drag-region]"])), true);
  assert.equal(isDragTarget(el(["[data-drag-region]", "button"])), false);
  assert.equal(isDragTarget(el([])), false);
  assert.equal(isDragTarget(null), false);
});
