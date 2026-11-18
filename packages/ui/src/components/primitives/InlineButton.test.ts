import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineButton, onPressKey, pressesButton } from "./InlineButton";

const key = (k: string, repeat = false) => {
  let prevented = false;
  return {
    e: {
      key: k,
      repeat,
      preventDefault: () => {
        prevented = true;
      },
    },
    prevented: () => prevented,
  };
};

test("Enter and Space press the button; Space does not scroll", () => {
  for (const k of ["Enter", " "]) {
    let pressed = 0;
    const ev = key(k);
    onPressKey(ev.e, () => pressed++);
    assert.equal(pressed, 1, k);
    assert.equal(ev.prevented(), true, k);
  }
});

test("other keys pass through untouched (Tab, letters, arrows)", () => {
  for (const k of ["Tab", "a", "ArrowDown", "Escape"]) {
    let pressed = 0;
    const ev = key(k);
    onPressKey(ev.e, () => pressed++);
    assert.equal(pressed, 0, k);
    assert.equal(ev.prevented(), false, k);
  }
  assert.equal(pressesButton("Enter"), true);
  assert.equal(pressesButton("x"), false);
});

test("a held key presses once", () => {
  let pressed = 0;
  onPressKey(key("Enter", true).e, () => pressed++);
  assert.equal(pressed, 0);
});

test("renders an inline, focusable span with button semantics (it wraps with the text, unlike <button>)", () => {
  const html = renderToStaticMarkup(
    createElement(InlineButton, { onPress: () => undefined, className: "octo-file-link", title: "Open a.ts", children: "a.ts" }),
  );
  assert.match(html, /^<span /);
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /class="octo-file-link"/);
  assert.doesNotMatch(html, /<button/);
});
