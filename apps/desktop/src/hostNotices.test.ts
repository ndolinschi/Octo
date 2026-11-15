import assert from "node:assert/strict";
import test from "node:test";
import { noticeSummary, parseNotices } from "./hostNotices";

test("notices: the shell's snake_case entries become notices", () => {
  assert.deepEqual(parseNotices([{ kind: "router_failed", message: " The router stopped. ", log_tail: "line 1\nline 2" }]), [
    { kind: "router_failed", message: "The router stopped.", logTail: "line 1\nline 2" },
  ]);
});

test("notices: nothing, garbage and entries without a message give an empty list or are dropped", () => {
  assert.deepEqual(parseNotices([]), []);
  assert.deepEqual(parseNotices(undefined), []);
  assert.deepEqual(parseNotices("x"), []);
  assert.deepEqual(parseNotices([null, 3, { kind: "router_failed" }, { kind: 1, message: "m" }, { kind: "k", message: "  " }]), []);
  assert.deepEqual(parseNotices([{ kind: "k", message: "m" }]), [{ kind: "k", message: "m", logTail: "" }]);
});

test("notices: the router notice says Octo works without the router", () => {
  const s = noticeSummary({ kind: "router_failed", message: "The router did not answer /health within 20 s.", logTail: "" });
  assert.equal(s.includes("works without it"), true);
  assert.equal(s.includes("did not answer"), true);
  assert.equal(noticeSummary({ kind: "other", message: "hello", logTail: "" }), "hello");
});
