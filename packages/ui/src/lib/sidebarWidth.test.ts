import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebarWidth";

test("clampSidebar keeps the width within 200–480 and whole", () => {
  assert.equal(clampSidebar(100), SIDEBAR_MIN);
  assert.equal(clampSidebar(900), SIDEBAR_MAX);
  assert.equal(clampSidebar(300.6), 301);
  assert.equal(clampSidebar(SIDEBAR_DEFAULT), 260);
});

test("the default width is the --spacing-sidebar token", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`--spacing-sidebar: ${SIDEBAR_DEFAULT}px;`));
});
