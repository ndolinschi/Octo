import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PopupList } from "./PopupList";

test('PopupList role="option" omits invalid aria-checked while keeping aria-selected and sr-only current text', () => {
  const html = renderToStaticMarkup(
    createElement(PopupList, {
      label: "Models",
      activeId: "a",
      onActive: () => undefined,
      onChoose: () => undefined,
      sections: [
        {
          title: "Available",
          rows: [
            { id: "a", label: "Claude Sonnet", checked: true, run: () => undefined },
            { id: "b", label: "GPT-5", checked: false, run: () => undefined },
          ],
        },
      ],
    }),
  );

  assert.match(html, /role="option"[^>]*aria-selected="true"/);
  assert.match(html, /role="option"[^>]*aria-selected="false"/);
  assert.doesNotMatch(html, /aria-checked=/, 'role="option" must not have invalid aria-checked attribute');
  assert.match(html, /<span class="sr-only">\(current\)<\/span>/);
});

test("PopupList tall variant uses 100dvh instead of 100vh for mobile dynamic viewports", () => {
  const html = renderToStaticMarkup(
    createElement(PopupList, {
      label: "Models",
      activeId: null,
      tall: true,
      onActive: () => undefined,
      onChoose: () => undefined,
      sections: [{ title: "", rows: [{ id: "a", label: "Claude Sonnet", run: () => undefined }] }],
    }),
  );

  assert.match(html, /100dvh-88px/);
  assert.doesNotMatch(html, /100vh-88px/);
});
