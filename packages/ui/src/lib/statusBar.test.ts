import assert from "node:assert/strict";
import test from "node:test";
import { changedFileCount, changedText, connectionText, projectCounts, waitingText, windowTitle, workingText } from "./statusBar";

test("a file changed in several turns counts once, the same path in another folder counts again", () => {
  const turns = [
    {
      files: [
        { path: "a.ts", folder: "f" },
        { path: "b.ts", folder: "f" },
      ],
    },
    {
      files: [
        { path: "a.ts", folder: "f" },
        { path: "a.ts", folder: "g" },
      ],
    },
  ];
  assert.equal(changedFileCount(turns), 3);
  assert.equal(changedFileCount([]), 0);
});

test("texts", () => {
  assert.equal(changedText(1), "1 changed file");
  assert.equal(changedText(2), "2 changed files");
  assert.equal(workingText(0), null);
  assert.equal(workingText(1), "1 project working");
  assert.equal(workingText(2), "2 projects working");
  assert.equal(connectionText("online"), null);
  assert.equal(connectionText("offline")?.text, "Offline");
  assert.doesNotMatch(connectionText("offline")?.hint ?? "", /bridge/i);
  assert.equal(connectionText("checking")?.text, "Connecting…");
  assert.equal(connectionText("offline", "refused")?.text, "Access refused");
  assert.equal(connectionText("offline", "unreadable")?.text, "Unreadable answer");
  assert.equal(connectionText("offline", "unanswered")?.text, "Not answering");
  assert.equal(connectionText("online", "refused"), null);
});

test("UX-03: a running project that waits for the person counts as waiting, not working", () => {
  const c = projectCounts([
    { status: "running", needs_you: true, attention: "needs_you" },
    { status: "running", attention: "none" },
    { status: "idle", attention: "failed" },
  ]);
  assert.deepEqual(c, { working: 1, waiting: 1 });
  assert.equal(waitingText(c.waiting), "1 project needs you");
  assert.equal(waitingText(2), "2 projects need you");
  assert.equal(waitingText(0), null);
  assert.deepEqual(projectCounts(null), { working: 0, waiting: 0 });
});

test("UX-03: Needs you goes ahead of the window title", () => {
  assert.equal(windowTitle("Atlas — Fix tests", true), "Needs you · Atlas — Fix tests · Octo");
  assert.equal(windowTitle("Atlas — Fix tests", false), "Atlas — Fix tests · Octo");
});
