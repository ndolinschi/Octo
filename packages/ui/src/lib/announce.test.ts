import assert from "node:assert/strict";
import test from "node:test";
import { askAnnouncement, endAnnouncement, newIds } from "./announce";
import { formatDuration } from "./format";

test("endAnnouncement says how the request ended, with the head's time", () => {
  assert.equal(endAnnouncement("completed", 8200), "Finished: Worked for 8s");
  assert.equal(endAnnouncement("failed", 8000), "Failed after 8s");
  assert.equal(endAnnouncement("cancelled", 75_000), `Stopped after ${formatDuration(75_000)}`);
  assert.equal(endAnnouncement("completed", 400), "Finished");
  assert.equal(endAnnouncement("cancelled", null), "Stopped");
});

test("askAnnouncement names the project and what it asks", () => {
  assert.equal(askAnnouncement("Atlas API", "Run  npm\ntest"), "Atlas API asks: Run npm test");
  assert.equal(askAnnouncement("Atlas API", " "), "Atlas API is waiting for you");
});

test("newIds lists only what was not seen, in order", () => {
  assert.deepEqual(newIds(new Set(["a"]), [{ id: "a" }, { id: "b" }, { id: "c" }]), ["b", "c"]);
  assert.deepEqual(newIds(new Set(), []), []);
});
