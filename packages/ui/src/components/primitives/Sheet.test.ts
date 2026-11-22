import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SheetFrame } from "./Sheet";
import { focusModalPanel, isEscapeInNestedOverlay } from "./useModal";

type FakeEl = {
  parent: FakeEl | null;
  closest(selector: string): FakeEl | null;
  contains(node: unknown): boolean;
};

function makeFakeEl(opts: { matches?: (selector: string) => boolean; parent?: FakeEl | null } = {}): FakeEl {
  const el: FakeEl = {
    parent: opts.parent ?? null,
    closest(selector: string) {
      if (opts.matches?.(selector)) return el;
      return el.parent?.closest(selector) ?? null;
    },
    contains(node: unknown) {
      let cur = node as FakeEl | null;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parent ?? null;
      }
      return false;
    },
  };
  return el;
}

test("SheetFrame renders tabIndex=-1 on dialog panel and wires onClick on scrim", () => {
  let closed = 0;
  const onClose = () => {
    closed += 1;
  };
  const html = renderToStaticMarkup(createElement(SheetFrame, { label: "More", state: "open", onClose, children: createElement("p", null, "Body") }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /class="octo-scrim /);

  // Verify the scrim element uses onClick (absorbing touch/mouse click without click-through)
  const tree = SheetFrame({ label: "More", state: "open", onClose, children: createElement("p", null, "Body") }) as ReactElement<{
    children: [ReactElement<{ onClick?: () => void; onMouseDown?: () => void; className?: string }>, ReactElement<{ tabIndex?: number }>];
  }>;
  const [scrim, panel] = tree.props.children;
  assert.match(scrim.props.className ?? "", /\bocto-scrim\b/);
  assert.equal(typeof scrim.props.onClick, "function", "scrim must use onClick to prevent touch click-through");
  assert.equal(scrim.props.onMouseDown, undefined, "scrim must not rely on onMouseDown");
  assert.equal(panel.props.tabIndex, -1);

  scrim.props.onClick?.();
  assert.equal(closed, 1);
});

test("focusModalPanel focuses the panel itself when no focusable descendant exists yet", () => {
  let panelFocused = 0;
  const panel = {
    querySelector: () => null,
    focus: () => {
      panelFocused += 1;
    },
  };
  focusModalPanel(panel);
  assert.equal(panelFocused, 1);
});

test("focusModalPanel prefers [data-autofocus], then first focusable descendant, over the panel", () => {
  let autoFocused = 0;
  let panelFocused = 0;
  const autoEl = {
    focus: () => {
      autoFocused += 1;
    },
  } as unknown as HTMLElement;
  const panel = {
    querySelector: (selector: string) => (selector === "[data-autofocus]" ? autoEl : null),
    focus: () => {
      panelFocused += 1;
    },
  };
  focusModalPanel(panel);
  assert.equal(autoFocused, 1);
  assert.equal(panelFocused, 0);
});

test("Escape closes Sheet even when focus is still on the opener outside the panel", () => {
  const sheetPanel = makeFakeEl({ matches: (s) => s.includes(".octo-sheet") });
  const openerButton = makeFakeEl();
  assert.equal(
    isEscapeInNestedOverlay(openerButton as unknown as Element, sheetPanel),
    false,
    "opener outside panel is not a nested overlay, so Escape must close the Sheet",
  );
});

test("Escape is ignored when target is inside a nested portalled menu, listbox, or overlay", () => {
  const sheetPanel = makeFakeEl({ matches: (s) => s.includes(".octo-sheet") });

  const portalledPopover = makeFakeEl({ matches: (s) => s.includes(".octo-overlay") });
  const popoverInput = makeFakeEl({ parent: portalledPopover });
  assert.equal(isEscapeInNestedOverlay(popoverInput as unknown as Element, sheetPanel), true);

  const portalledMenu = makeFakeEl({ matches: (s) => s.includes('[role="menu"]') });
  const menuItem = makeFakeEl({ parent: portalledMenu });
  assert.equal(isEscapeInNestedOverlay(menuItem as unknown as Element, sheetPanel), true);

  const portalledListbox = makeFakeEl({ matches: (s) => s.includes('[role="listbox"]') });
  const option = makeFakeEl({ parent: portalledListbox });
  assert.equal(isEscapeInNestedOverlay(option as unknown as Element, sheetPanel), true);
});

test("Escape closes Dialog and CommandPalette when target is inside the panel itself", () => {
  const dialogPanel = makeFakeEl({ matches: (s) => s.includes(".octo-overlay") });
  const listboxChild = makeFakeEl({ matches: (s) => s.includes('[role="listbox"]'), parent: dialogPanel });
  const optionInsidePalette = makeFakeEl({ parent: listboxChild });
  assert.equal(isEscapeInNestedOverlay(optionInsidePalette as unknown as Element, dialogPanel), false);
});
