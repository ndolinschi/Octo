import assert from "node:assert/strict";
import test from "node:test";
import { DraftBus } from "./draftBus";

test("a saved text reaches the other members, never the saver", () => {
  const bus = new DraftBus();
  const a: string[] = [];
  const b: string[] = [];
  const ma = bus.join((t) => a.push(t));
  bus.join((t) => b.push(t));
  ma.save("hello");
  assert.deepEqual(a, []);
  assert.deepEqual(b, ["hello"]);
  assert.equal(bus.value, "hello");
});

test("saving the text already held notifies nobody", () => {
  const bus = new DraftBus("x");
  const heard: string[] = [];
  bus.join((t) => heard.push(t));
  const other = bus.join(() => undefined);
  other.save("x");
  assert.deepEqual(heard, []);
});

test("a member that left hears nothing; the text is kept for the next one", () => {
  const bus = new DraftBus();
  const heard: string[] = [];
  const gone = bus.join((t) => heard.push(t));
  const other = bus.join(() => undefined);
  gone.leave();
  other.save("later");
  assert.deepEqual(heard, []);
  assert.equal(bus.value, "later");
});
