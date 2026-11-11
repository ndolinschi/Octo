import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DOCKED_QUERY, DOCK_MIN_WIDTH, DRAWER_BELOW, DRAWER_QUERY, FILE_GROUP_MIN_FRACTION, MIN_GROUP, TOOL_GROUP_MAX_FRACTION } from "./constants";

test("the drawer breakpoint in styles.css is the one in constants.ts", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const token = /--breakpoint-drawer:\s*(\d+)px/.exec(css);
  assert.ok(token, "styles.css declares --breakpoint-drawer");
  assert.equal(Number(token[1]), DRAWER_BELOW);
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
