import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailHeader, Panel, PanelFilters } from "./Panel";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

test("a panel draws header, filters, views, body and footer in that order", () => {
  const out = html(
    createElement(Panel, {
      name: "t",
      title: "Things",
      meta: "3",
      actions: createElement("button", null, "Add"),
      filters: createElement(PanelFilters, null, "F"),
      views: createElement("div", { "data-v": "" }, "V"),
      footer: "foot",
      children: "BODY",
    }),
  );
  const at = (s: string) => out.indexOf(s);
  assert.ok(at("data-panel-header") < at("data-panel-filters"));
  assert.ok(at("data-panel-filters") < at("data-v"));
  assert.ok(at("data-v") < at("data-panel-body"));
  assert.ok(at("data-panel-body") < at("data-panel-footer"));
  assert.match(out, /data-panel="t"/);
  assert.match(out, /Things/);
});

test("without actions, filters and footer the panel has only a header and a body", () => {
  const out = html(createElement(Panel, { name: "t", title: "Things", children: "BODY" }));
  assert.ok(!out.includes("data-panel-actions"));
  assert.ok(!out.includes("data-panel-filters"));
  assert.ok(!out.includes("data-panel-footer"));
  assert.ok(out.includes("BODY"));
});

test("a filter row keeps the frame's inset unless it is flush inside a scroller", () => {
  assert.match(html(createElement(PanelFilters, null, "x")), /px-pane/);
  assert.ok(!html(createElement(PanelFilters, { flush: true, children: "x" })).includes("px-pane"));
});

test("a detail header outside a list-detail has no Back control and shows its meta line", () => {
  const out = html(createElement(DetailHeader, { title: "T", meta: "Nov 12" }));
  assert.ok(!out.includes("Back to"));
  assert.match(out, /data-detail-header/);
  assert.match(out, /Nov 12/);
});
