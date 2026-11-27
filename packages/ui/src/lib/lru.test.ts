import assert from "node:assert/strict";
import test from "node:test";
import { LruCache } from "./lru";

test("LruCache evicts least-recently-used entries when capacity is exceeded", () => {
  const c = new LruCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // refreshes "a", so "b" is oldest
  c.set("c", 3);
  assert.equal(c.has("b"), false);
  assert.equal(c.peek("a"), 1);
  assert.equal(c.peek("c"), 3);
  assert.equal(c.size, 2);
});

test("LruCache updates existing keys without growing size and supports delete/clear", () => {
  const c = new LruCache<number, string>(2);
  c.set(1, "one");
  c.set(2, "two");
  c.set(1, "ONE");
  assert.equal(c.size, 2);
  assert.equal(c.peek(1), "ONE");
  assert.equal(c.delete(2), true);
  assert.equal(c.size, 1);
  c.clear();
  assert.equal(c.size, 0);
});
