import assert from "node:assert/strict";
import test from "node:test";
import { QUIET_FOCUS_ATTR, QUIET_ROOT_ATTR, quietFocus, quietUntilInput } from "./quietFocus";

function fake() {
  const attrs = new Set<string>();
  const listeners = new Map<string, Set<(e: never) => void>>();
  let focused = 0;
  const el = {
    focus: () => void focused++,
    setAttribute: (n: string) => void attrs.add(n),
    removeAttribute: (n: string) => void attrs.delete(n),
    addEventListener: (t: string, f: (e: never) => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(f),
    removeEventListener: (t: string, f: (e: never) => void) => void listeners.get(t)?.delete(f),
  };
  const fire = (t: string) => [...(listeners.get(t) ?? [])].forEach((f) => f({} as never));
  return { el, attrs, fire, focused: () => focused, count: (t: string) => listeners.get(t)?.size ?? 0 };
}

test("quiet focus: marked until the first key, then unmarked and unbound", () => {
  const f = fake();
  quietFocus(f.el as never);
  assert.equal(f.focused(), 1);
  assert.ok(f.attrs.has(QUIET_FOCUS_ATTR));
  f.fire("keydown");
  assert.ok(!f.attrs.has(QUIET_FOCUS_ATTR));
  assert.equal(f.count("keydown") + f.count("blur"), 0);
});

test("quiet focus: leaving clears the mark too; nothing to focus is a no-op", () => {
  const f = fake();
  quietFocus(f.el as never);
  f.fire("blur");
  assert.ok(!f.attrs.has(QUIET_FOCUS_ATTR));
  quietFocus(null);
});

test("a quiet panel root: marked until the first key or press inside; focus from outside marks it again", () => {
  const f = fake();
  const root = { ...f.el, contains: () => false };
  const win = fake();
  const stop = quietUntilInput(root as never, win.el as never);
  assert.ok(f.attrs.has(QUIET_ROOT_ATTR));
  f.fire("pointerdown");
  assert.ok(!f.attrs.has(QUIET_ROOT_ATTR));
  f.fire("focusin");
  assert.ok(f.attrs.has(QUIET_ROOT_ATTR));
  f.fire("keydown");
  assert.ok(!f.attrs.has(QUIET_ROOT_ATTR));
  stop();
  assert.equal(f.count("keydown") + f.count("pointerdown") + f.count("focusin") + win.count("keydown"), 0);
  quietUntilInput(null)();
});
