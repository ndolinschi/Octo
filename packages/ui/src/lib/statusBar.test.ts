import assert from "node:assert/strict";
import test from "node:test";
import { changedFileCount, changedText, connectionText, workingText } from "./statusBar";

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
  assert.equal(workingText(2), "2 working");
  assert.equal(connectionText("online"), null);
  assert.equal(connectionText("offline")?.text, "Bridge offline");
  assert.equal(connectionText("checking")?.text, "Connecting…");
  assert.equal(connectionText("offline", "refused")?.text, "Access refused");
  assert.equal(connectionText("offline", "unreadable")?.text, "Unreadable answer");
  assert.equal(connectionText("online", "refused"), null);
});
