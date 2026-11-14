import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineError, isUnanswered, withDeadline } from "./deadline";

test("P2-4: a read that settles in time passes through, value and failure alike", async () => {
  assert.equal(await withDeadline(Promise.resolve(3), 50), 3);
  await assert.rejects(withDeadline(Promise.reject(new Error("bad")), 50), (e: unknown) => e instanceof Error && e.message === "bad");
});

test("P2-4: a read that never settles fails with code `unanswered` after the deadline", async () => {
  const hung = new Promise<number>(() => undefined);
  const started = Date.now();
  const e: unknown = await withDeadline(hung, 30).catch((x: unknown) => x);
  assert.ok(e instanceof DeadlineError);
  assert.equal(isUnanswered(e), true);
  assert.equal(e.code, "unanswered");
  assert.ok(Date.now() - started >= 25);
  assert.equal(isUnanswered(new Error("x")), false);
});
