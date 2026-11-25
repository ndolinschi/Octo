import type { Bridge } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { takeSideQuestion } from "../../state/workspace/sideStart";
import { runSlash } from "./slashRun";

test("runSlash /memory opens memory tool when enabled and shows notice when blocked", async () => {
  const opened: string[] = [];
  const notes: { kind: string; text?: string }[] = [];
  const base = {
    bridge: {} as Bridge,
    projectId: "prj_1",
    mode: null,
    openModel: () => undefined,
    openTool: (t: "review" | "memory" | "side") => opened.push(t),
    openSettings: () => undefined,
    push: (note: { kind: string; text?: string }) => notes.push(note),
    rewindLast: undefined,
  };

  assert.equal(await runSlash({ ...base, memoryBlocked: false }, "memory", ""), true);
  assert.deepEqual(opened, ["memory"]);
  assert.equal(notes.length, 0);

  assert.equal(await runSlash({ ...base, memoryBlocked: true }, "memory", ""), true);
  assert.deepEqual(opened, ["memory"]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.kind, "info");
  assert.match(notes[0]?.text ?? "", /Memory is disabled/);
});

test("runSlash /btw queues the question and opens the side tool tab", async () => {
  const opened: string[] = [];
  const base = {
    bridge: {} as Bridge,
    projectId: "prj_btw",
    mode: null,
    openModel: () => undefined,
    openTool: (t: "review" | "memory" | "side") => opened.push(t),
    openSettings: () => undefined,
    push: () => undefined,
    rewindLast: undefined,
  };

  assert.equal(await runSlash(base, "btw", "How does backoff work?"), true);
  assert.deepEqual(opened, ["side"]);
  assert.equal(takeSideQuestion("prj_btw"), "How does backoff work?");
  assert.equal(takeSideQuestion("prj_btw"), null);
});
