import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow } from "./ListRow";

const html = (props: Parameters<typeof ListRow>[0]) => renderToStaticMarkup(createElement(ListRow, props));
const actions = createElement("button", { type: "button" }, "Stop");

// Work-surface polish item 5. The overlay itself is CSS (styles.css, "Row actions"); these pin the hooks it needs.
test("hidden row actions are an overlay of the row, and the meta is a tail that gives way to them", () => {
  const out = html({ title: "vite", meta: "1m", trailing: actions, onClick: () => {} });
  assert.match(out, /class="group [^"]*\bocto-row-host\b/);
  const trailing = /<span class="([^"]*)"><button type="button">Stop/.exec(out)?.[1] ?? "";
  // Shown on the row's hover or focus, always on touch: styles.css, `.octo-row-actions`.
  assert.match(trailing, /\bocto-row-actions\b/);
  assert.match(out, /<span aria-hidden="true" data-row-tail="true" class="[^"]*">1m<\/span>/);
});

test("a selected row is a host with the selection fill the overlay's tint follows (styles.css: .octo-row-host.bg-active)", () => {
  assert.match(html({ title: "vite", trailing: actions, selected: true, onClick: () => {} }), /class="group [^"]*\bocto-row-host\b[^"]*\bbg-active\b/);
});

test("actions shown at all times stay in the flow; a row without actions is no host", () => {
  assert.doesNotMatch(html({ title: "vite", meta: "1m", trailing: actions, trailingShown: true }), /octo-row-(host|actions)/);
  assert.doesNotMatch(html({ title: "vite", meta: "1m" }), /octo-row-host/);
});
