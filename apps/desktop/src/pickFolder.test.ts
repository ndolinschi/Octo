import assert from "node:assert/strict";
import test from "node:test";
import { pickFolder } from "./pickFolder";

test("a chosen folder is returned, with the directory options", async () => {
  let seen: unknown;
  const got = await pickFolder((o) => {
    seen = o;
    return Promise.resolve("/Users/me/code");
  });
  assert.equal(got, "/Users/me/code");
  assert.deepEqual(seen, { directory: true, multiple: false, title: "Choose a folder" });
});

test("cancel gives null; an array gives its first entry", async () => {
  assert.equal(await pickFolder(() => Promise.resolve(null)), null);
  assert.equal(await pickFolder(() => Promise.resolve(["/a", "/b"])), "/a");
  assert.equal(await pickFolder(() => Promise.resolve([])), null);
});

test("an error gives null and a console warning", async () => {
  const warn = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...a: unknown[]) => void calls.push(a);
  try {
    assert.equal(await pickFolder(() => Promise.reject(new Error("no dialog"))), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(calls.length, 1);
});
