import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequiredContext } from "./context";

test("the required hook returns the provided value", () => {
  const { Provider, useRequired } = createRequiredContext<{ n: number }>("useThing");
  const Show = () => createElement("span", null, String(useRequired().n));
  assert.equal(renderToStaticMarkup(createElement(Provider, { value: { n: 7 } }, createElement(Show))), "<span>7</span>");
});

test("outside its provider the required hook throws, naming itself; the optional one returns null", () => {
  const { useRequired, useOptional } = createRequiredContext<string>("useThing");
  const Req = () => createElement("span", null, useRequired());
  const Opt = () => createElement("span", null, String(useOptional()));
  assert.throws(() => renderToStaticMarkup(createElement(Req)), /useThing outside its provider/);
  assert.equal(renderToStaticMarkup(createElement(Opt)), "<span>null</span>");
});

test("falsy values are still values", () => {
  const { Provider, useRequired } = createRequiredContext<number>("useCount");
  const Show = () => createElement("span", null, String(useRequired()));
  assert.equal(renderToStaticMarkup(createElement(Provider, { value: 0 }, createElement(Show))), "<span>0</span>");
});

test("two contexts do not share values", () => {
  const a = createRequiredContext<string>("useA");
  const b = createRequiredContext<string>("useB");
  const Show = () => createElement("span", null, b.useOptional() ?? "none");
  assert.equal(renderToStaticMarkup(createElement(a.Provider, { value: "x" }, createElement(Show))), "<span>none</span>");
});
