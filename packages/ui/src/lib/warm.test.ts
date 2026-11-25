import assert from "node:assert/strict";
import test from "node:test";
import { registerWarm, warm } from "./warm";
import { saveData, warmOnIdle, type IdleScheduler } from "./warmSchedule";

/** An idle scheduler the test drives by hand. */
function manualIdle() {
  const queue: (() => void)[] = [];
  const idle: IdleScheduler = (run) => {
    queue.push(run);
    return () => {
      const i = queue.indexOf(run);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  const tick = async () => {
    queue.shift()?.();
    // Let the warmed loader settle and the queue schedule the next key.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { idle, queue, tick };
}

test("a key's loaders run once, however often it is warmed", async () => {
  let n = 0;
  registerWarm("t-once", async () => (n += 1));
  registerWarm("t-once", async () => (n += 10));
  await warm("t-once");
  await warm("t-once");
  assert.equal(n, 11);
});

test("a failed load is forgotten, so the next intent tries again", async () => {
  let n = 0;
  registerWarm("t-fail", () => (++n === 1 ? Promise.reject(new Error("offline")) : Promise.resolve()));
  await warm("t-fail");
  await warm("t-fail");
  await warm("t-fail");
  assert.equal(n, 2);
});

test("an unknown key is a no-op", async () => {
  await warm("t-nothing-registered");
});

test("idle warming takes one key per idle slot, in order", async () => {
  const order: string[] = [];
  for (const k of ["t-a", "t-b", "t-c"]) registerWarm(k, async () => void order.push(k));
  const m = manualIdle();
  warmOnIdle(["t-a", "t-b", "t-c"], m.idle, false);
  assert.deepEqual(order, []);
  await m.tick();
  assert.deepEqual(order, ["t-a"]);
  await m.tick();
  await m.tick();
  assert.deepEqual(order, ["t-a", "t-b", "t-c"]);
  assert.equal(m.queue.length, 0);
});

test("cancelling stops the idle queue; Save-Data skips it", async () => {
  const order: string[] = [];
  for (const k of ["t-x", "t-y"]) registerWarm(k, async () => void order.push(k));
  const m = manualIdle();
  const cancel = warmOnIdle(["t-x", "t-y"], m.idle, false);
  await m.tick();
  cancel();
  await m.tick();
  assert.deepEqual(order, ["t-x"]);
  const s = manualIdle();
  warmOnIdle(["t-y"], s.idle, true);
  assert.equal(s.queue.length, 0);
});

test("saveData reads navigator.connection.saveData defensively", () => {
  assert.equal(saveData(undefined), false);
  assert.equal(saveData({}), false);
  assert.equal(saveData({ connection: null }), false);
  assert.equal(saveData({ connection: { saveData: false } }), false);
  assert.equal(saveData({ connection: { saveData: true } }), true);
});
