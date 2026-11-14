import test from "node:test";
import assert from "node:assert/strict";
import { createLayerStack } from "./historyLayer";

/** A fake history: entries of tokens, an index; `go` is asynchronous like the real one (settled by `arrive`). */
function fakeHistory() {
  const entries: (string | null)[] = [null];
  let at = 0;
  const moves: number[] = [];
  return {
    env: {
      push(token: string) {
        entries.splice(at + 1);
        entries.push(token);
        at = entries.length - 1;
      },
      go(delta: number) {
        moves.push(delta);
      },
      token: () => entries[at] ?? null,
    },
    /** The browser performs the oldest pending move; returns false when there is none. */
    arrive() {
      const d = moves.shift();
      if (d === undefined) return false;
      at = Math.max(0, Math.min(entries.length - 1, at + d));
      return true;
    },
    /** A navigation of its own (a hash change): a new entry without a token. */
    navigate() {
      entries.splice(at + 1);
      entries.push(null);
      at = entries.length - 1;
    },
    back() {
      at = Math.max(0, at - 1);
    },
    get at() {
      return at;
    },
    get length() {
      return entries.length;
    },
  };
}

test("Back closes the top layer only, in order", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  const closed: string[] = [];
  s.open(() => closed.push("sheet"));
  s.open(() => closed.push("picker"));
  assert.equal(h.at, 2);
  h.back();
  s.sync();
  assert.deepEqual(closed, ["picker"]);
  h.back();
  s.sync();
  assert.deepEqual(closed, ["picker", "sheet"]);
  assert.equal(s.depth(), 0);
});

test("closing from the UI goes back over the entry without calling onPop", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  let popped = 0;
  const t = s.open(() => (popped += 1));
  s.close(t);
  assert.equal(h.arrive(), true);
  s.sync();
  assert.equal(h.at, 0);
  assert.equal(popped, 0);
});

test("a layer opened while a close travels is pushed after it arrives", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  const a = s.open(() => undefined);
  s.close(a);
  s.open(() => undefined);
  assert.equal(h.length, 2, "not pushed yet");
  h.arrive();
  s.sync();
  assert.equal(h.at, 1);
  assert.equal(h.length, 2);
  assert.equal(s.depth(), 1);
});

test("a navigation closes every layer and Back skips their stale entries", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  let closed = 0;
  s.open(() => (closed += 1));
  h.navigate();
  s.sync();
  assert.equal(closed, 1);
  assert.equal(s.depth(), 0);
  h.back();
  s.sync();
  assert.equal(h.arrive(), true, "a stale entry is skipped");
  assert.equal(h.at, 0);
});

test("a sheet that closes after the panel it opened dies in place; Back skips its entry", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  const closed: string[] = [];
  const sheet = s.open(() => closed.push("sheet"));
  s.open(() => closed.push("panel"));
  s.close(sheet);
  assert.equal(h.arrive(), false, "no history move");
  assert.equal(s.depth(), 1);
  h.back();
  s.sync();
  assert.deepEqual(closed, ["panel"]);
  assert.equal(h.at, 1);
  assert.equal(h.arrive(), true, "the dead sheet's entry is skipped");
  s.sync();
  assert.equal(h.at, 0);
});

test("closing the top layer also goes back over dead layers under it", () => {
  const h = fakeHistory();
  const s = createLayerStack(h.env);
  const a = s.open(() => undefined);
  const b = s.open(() => undefined);
  s.close(a);
  s.close(b);
  assert.equal(h.arrive(), true);
  s.sync();
  assert.equal(h.at, 0);
  assert.equal(s.depth(), 0);
});
