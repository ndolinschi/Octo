import { emptyProjectState, withSessions, type ProjectState } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { sessionTab } from "../../state/workspace/layout";
import { tabInfo } from "./tabInfo";

function stateWithSession(over: Partial<ProjectState["sessions"]["list"][number]> = {}): ProjectState {
  const session = {
    id: "ses_2",
    kind: "main" as const,
    title: "Plan the release",
    state: "idle" as const,
    model: "claude-sonnet-5-5",
    started_at: "2026-11-16T00:00:00Z",
    last_activity_at: "2026-11-16T00:00:00Z",
    exchanges: 1,
    children: 0,
    current: false,
    default: false,
    archived: false,
    root_agent_id: "agt_2",
    can_message: true,
    ...over,
  };
  return withSessions(emptyProjectState(), [session]);
}

test("tabInfo shows a main session tab's own title and state instead of repeating the project name", () => {
  const info = tabInfo(sessionTab("ses_2"), {
    state: stateWithSession({ title: "Fix upload race", state: "working" }),
    projectName: "Atlas",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
  });
  assert.equal(info.label, "Fix upload race");
  assert.equal(info.detail, undefined);
  assert.equal(info.title, "Atlas: Fix upload race");
  assert.equal(info.status, "running");
  assert.equal(info.glyph, "working");
});

test("tabInfo falls back to New session for an untitled or just-created main session tab", () => {
  const info = tabInfo(sessionTab("ses_unknown"), {
    state: stateWithSession({ title: "" }),
    projectName: "Atlas",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
  });
  assert.equal(info.label, "New session");
  assert.equal(info.title, "Atlas: New session");
});
