import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DOCKED_QUERY,
  DOCK_MIN_WIDTH,
  DRAWER_BELOW,
  DRAWER_QUERY,
  EASE_OUT_QUINT,
  FILE_GROUP_MIN_FRACTION,
  MIN_GROUP,
  MOTION_BASE_MS,
  MOTION_FAST_MS,
  TOOL_GROUP_MAX_FRACTION,
} from "./constants";

test("the drawer breakpoint in styles.css is the one in constants.ts", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const token = /--breakpoint-drawer:\s*(\d+)px/.exec(css);
  assert.ok(token, "styles.css declares --breakpoint-drawer");
  assert.equal(Number(token[1]), DRAWER_BELOW);
});

test("the motion tokens in styles.css are the ones in constants.ts", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.equal(/--motion-fast:\s*(\d+)ms/.exec(css)?.[1], String(MOTION_FAST_MS));
  assert.equal(/--motion-base:\s*(\d+)ms/.exec(css)?.[1], String(MOTION_BASE_MS));
  assert.equal(/--ease-out-quint:\s*([^;]+);/.exec(css)?.[1], EASE_OUT_QUINT);
});

test("no transition or animation in styles.css names a layout property or a bare duration", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/transition(?:-property)?:\s*([^;]+);/g)) {
    const value = m[1] ?? "";
    assert.doesNotMatch(value, /\b(width|height|top|left|right|bottom|margin|padding|grid-template-rows|grid-template-columns|all)\b/, value);
  }
  for (const m of css.matchAll(/transition-duration:\s*([^;]+);/g)) assert.match(m[1] ?? "", /var\(--motion-|0\.001ms|0s/, m[1]);
});

test("media queries are built from the constants", () => {
  assert.equal(DOCKED_QUERY, `(min-width: ${DOCK_MIN_WIDTH}px)`);
  assert.equal(DRAWER_QUERY, `(max-width: ${DRAWER_BELOW - 1}px)`, "max-width is inclusive, the token's `max-` variant is exclusive");
  assert.ok(DRAWER_BELOW < DOCK_MIN_WIDTH, "the drawer range and the docked range do not overlap");
});

test("layout fractions are fractions of a row", () => {
  for (const f of [FILE_GROUP_MIN_FRACTION, TOOL_GROUP_MAX_FRACTION]) assert.ok(f > 0 && f < 1);
  assert.ok(MIN_GROUP > 0);
});
