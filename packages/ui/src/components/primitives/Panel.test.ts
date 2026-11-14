import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DetailHeader, FormActions, Panel, PanelEmpty, PanelFilters } from "./Panel";

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

test("an empty panel is one centred block with a title; without a title it is the inline line", () => {
  const block = html(createElement(PanelEmpty, { title: "No notes yet", children: "Why." }));
  assert.match(block, /data-panel-empty-block/);
  assert.match(block, /data-empty-state/);
  assert.match(block, /No notes yet/);
  const line = html(createElement(PanelEmpty, null, "Nothing matches."));
  assert.match(line, /data-panel-empty=/);
  assert.ok(!line.includes("data-empty-state"));
});

test("an action row is plain at rest and an alertdialog with its question when it confirms", () => {
  assert.ok(!html(createElement(FormActions, null, "x")).includes("alertdialog"));
  const confirm = html(createElement(FormActions, { note: "Discard changes?", label: "Discard changes", children: "x" }));
  assert.match(confirm, /role="alertdialog"/);
  assert.match(confirm, /aria-label="Discard changes"/);
  assert.ok(confirm.indexOf("Discard changes?") < confirm.indexOf(">x<"));
});
