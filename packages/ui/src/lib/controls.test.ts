import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CONTROL, CONTROL_PX, CONTROL_SIZES, legacyIconSize, spinnerBox } from "./controls";

test("the scale is xs 24, sm 28, md 32, lg 40, ascending", () => {
  assert.deepEqual(
    CONTROL_SIZES.map((s) => CONTROL_PX[s]),
    [24, 28, 32, 40],
  );
});

test("styles.css declares the same pixels as --spacing-ctl-*", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const size of CONTROL_SIZES) {
    const token = new RegExp(`--spacing-ctl-${size}:\\s*(\\d+)px`).exec(css);
    assert.ok(token, `--spacing-ctl-${size} is declared`);
    assert.equal(Number(token[1]), CONTROL_PX[size]);
  }
});

test("every size names its own height, square and min-height class", () => {
  for (const size of CONTROL_SIZES) {
    assert.equal(CONTROL[size].h, `h-ctl-${size}`);
    assert.equal(CONTROL[size].square, `size-ctl-${size}`);
    assert.equal(CONTROL[size].minH, `min-h-ctl-${size}`);
  }
});

test("radius rule: 6px up to md, 8px at lg; glyphs are 14 or 16 and the ring grows with the size", () => {
  assert.deepEqual(
    CONTROL_SIZES.map((s) => CONTROL[s].radius),
    ["rounded-sm", "rounded-sm", "rounded-sm", "rounded-md"],
  );
  let last = 0;
  for (const size of CONTROL_SIZES) {
    assert.ok([14, 16].includes(CONTROL[size].glyph));
    assert.ok(CONTROL[size].spinner >= last);
    last = CONTROL[size].spinner;
  }
});

test("legacy icon button sizes keep their pixels", () => {
  assert.equal(CONTROL_PX[legacyIconSize("sm")], 24);
  assert.equal(CONTROL_PX[legacyIconSize("md")], 28);
});

test("spinner box: one per control size, numbers pass through", () => {
  assert.equal(spinnerBox("xs"), 12);
  assert.equal(spinnerBox("lg"), 16);
  assert.equal(spinnerBox(10), 10);
});
