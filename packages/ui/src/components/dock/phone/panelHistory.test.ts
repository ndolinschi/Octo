import test from "node:test";
import assert from "node:assert/strict";
import { fileKey } from "../../../lib/files";
import { CHAT, fileTab, parseTabId, type TabId } from "../../../state/workspace/layout";
import { reopenFor } from "./panelHistory";

const id = (raw: string): TabId => {
  const t = parseTabId(raw);
  assert.ok(t, raw);
  return t;
};

test("Back to a tab still open activates it", () => {
  const files = id("files");
  assert.deepEqual(reopenFor(files, [CHAT, files]), { kind: "activate", tab: files });
});

test("Back from a file whose row replaced the Files tab opens Files again, not the conversation", () => {
  assert.deepEqual(reopenFor(id("files"), [CHAT, id(fileTab(fileKey("local", "src/a.ts")))]), { kind: "tool", tool: "files" });
});

test("Back to a closed agent or session reopens it; to Chat, the conversation", () => {
  assert.deepEqual(reopenFor(id("agent:agt_1"), [CHAT]), { kind: "agent", agentId: "agt_1" });
  assert.deepEqual(reopenFor(id("session:ses_1"), [CHAT]), { kind: "session", sessionId: "ses_1" });
  assert.deepEqual(reopenFor(CHAT, []), { kind: "chat" });
});
