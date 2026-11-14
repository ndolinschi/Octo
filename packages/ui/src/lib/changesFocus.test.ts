import assert from "node:assert/strict";
import test from "node:test";
import { changesFocus, clearChangesFocus, requestChangesFocus, subscribeChangesFocus } from "./changesFocus";

test("changesFocus: a request is kept and announced; clearing announces once", () => {
  let calls = 0;
  const off = subscribeChangesFocus(() => calls++);
  requestChangesFocus({ turnId: 7, folder: "api", path: "src/x.ts" });
  assert.deepEqual(changesFocus(), { turnId: 7, folder: "api", path: "src/x.ts", seq: 1 });
  requestChangesFocus({ turnId: 8 });
  assert.equal(changesFocus()?.seq, 2);
  clearChangesFocus();
  clearChangesFocus();
  assert.equal(changesFocus(), null);
  assert.equal(calls, 3);
  off();
  requestChangesFocus({ turnId: 9 });
  assert.equal(calls, 3);
});
