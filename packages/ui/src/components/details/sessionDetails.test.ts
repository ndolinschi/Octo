import type { Agent, Folder, Workspace } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { INSIDE_WORDS, JARGON } from "../../lib/errors/words";
import { agentsInSession, filterMessagesForSession, latestRoutedAgent, resolveSessionFolders } from "./sessionDetails";

const mkAgent = (overrides: Partial<Agent> & { id: string }): Agent => ({
  project_id: "prj_1",
  parent_id: null,
  depth: 0,
  role: "orchestrator",
  title: "",
  task: "",
  model: "claude-sonnet-5-5",
  tier: null,
  status: "idle",
  result: null,
  error: null,
  spawn_tool_use_id: null,
  input_tokens: 0,
  output_tokens: 0,
  created_at: "2026-11-17T00:00:00Z",
  started_at: null,
  finished_at: null,
  ...overrides,
});

test("agentsInSession returns all ordered agents when sessionId is null", () => {
  const a1 = mkAgent({ id: "root_1", session_id: "ses_1" });
  const a2 = mkAgent({ id: "root_2", session_id: "ses_2" });
  const map = { root_1: a1, root_2: a2 };
  assert.deepEqual(
    agentsInSession(map, ["root_1", "missing", "root_2"], null).map((a) => a.id),
    ["root_1", "root_2"],
  );
});

test("agentsInSession isolates agents by session_id and parent chain fallback", () => {
  const root1 = mkAgent({ id: "root_1", session_id: "ses_1" });
  const child1 = mkAgent({ id: "sub_1", parent_id: "root_1", role: "Explorer", session_id: "ses_1" });
  const legacyChild1 = mkAgent({ id: "sub_1_legacy", parent_id: "sub_1", role: "Helper" });
  const root2 = mkAgent({ id: "root_2", session_id: "ses_2" });
  const child2 = mkAgent({ id: "sub_2", parent_id: "root_2", role: "Explorer", session_id: "ses_2" });
  const unlinkedLegacy = mkAgent({ id: "sub_unlinked", parent_id: "missing_parent", role: "Old" });
  const map = { root_1: root1, sub_1: child1, sub_1_legacy: legacyChild1, root_2: root2, sub_2: child2, sub_unlinked: unlinkedLegacy };
  const order = ["root_1", "sub_1", "sub_1_legacy", "root_2", "sub_2", "sub_unlinked"];

  assert.deepEqual(
    agentsInSession(map, order, "ses_1", "root_1").map((a) => a.id),
    ["root_1", "sub_1", "sub_1_legacy"],
  );
  assert.deepEqual(
    agentsInSession(map, order, "ses_2", "root_2").map((a) => a.id),
    ["root_2", "sub_2"],
  );
});

test("agentsInSession matches rootAgentId even when root has no session_id", () => {
  const root1 = mkAgent({ id: "root_1" });
  const sub1 = mkAgent({ id: "sub_1", parent_id: "root_1", role: "Reviewer" });
  const other = mkAgent({ id: "root_2", session_id: "ses_2" });
  const map = { root_1: root1, sub_1: sub1, root_2: other };
  assert.deepEqual(
    agentsInSession(map, ["root_1", "sub_1", "root_2"], "ses_1", "root_1").map((a) => a.id),
    ["root_1", "sub_1"],
  );
});

test("filterMessagesForSession drops messages tagged for other sessions and keeps untagged ones", () => {
  const msgs = [{ id: 1, session_id: "ses_1" }, { id: 2, session_id: "ses_2" }, { id: 3 }];
  assert.deepEqual(
    filterMessagesForSession(msgs, "ses_1").map((m) => m.id),
    [1, 3],
  );
  assert.deepEqual(
    filterMessagesForSession(msgs, null).map((m) => m.id),
    [1, 2, 3],
  );
});

test("latestRoutedAgent picks the newest agent with route_choice", () => {
  const old = mkAgent({ id: "a1", created_at: "2026-11-17T01:00:00Z", route_choice: "fast" });
  const newer = mkAgent({ id: "a2", created_at: "2026-11-17T02:00:00Z", route_choice: "deep" });
  const unrouted = mkAgent({ id: "a3", created_at: "2026-11-17T03:00:00Z" });
  assert.equal(latestRoutedAgent([old, unrouted, newer])?.id, "a2");
  assert.equal(latestRoutedAgent([unrouted]), undefined);
});

test("resolveSessionFolders returns project folders when legacy or shared checkout, and worktree paths when matched", () => {
  const projectFolders: Folder[] = [
    { id: "fld_api", label: "api", path: "/Users/maya/code/api" },
    { id: "fld_web", label: "web", path: "/Users/maya/code/web" },
  ];
  const legacy = resolveSessionFolders(projectFolders, null);
  assert.equal(legacy.workspaceTag, null);
  assert.equal(legacy.folders.length, 2);
  assert.equal(legacy.folders[0]?.path, "/Users/maya/code/api");

  const shared = resolveSessionFolders(projectFolders, { workspace: { id: "shared", kind: "shared", title: "Main checkout" } });
  assert.equal(shared.workspaceTag, "Main checkout");
  assert.doesNotMatch(shared.workspaceTag ?? "", INSIDE_WORDS);
  assert.doesNotMatch(shared.workspaceTag ?? "", JARGON);
  assert.equal(shared.folders[0]?.path, "/Users/maya/code/api");

  const workspaces: Workspace[] = [
    {
      id: "wrk_1",
      kind: "worktree",
      title: "Worktree · octo/fix-auth",
      state: "ready",
      branch: "octo/fix-auth",
      created_at: "2026-11-17T00:00:00Z",
      folders: [
        { workspace_id: "wrk_1", folder_id: "fld_api", folder_label: "api", path: "/tmp/wt/api", shared: false },
        { workspace_id: "wrk_1", folder_id: "fld_extra", path: "/tmp/wt/extra", shared: false },
      ],
    },
  ];

  const wt = resolveSessionFolders(
    projectFolders,
    { workspace: { id: "wrk_1", kind: "worktree", title: "Worktree · octo/fix-auth", branch: "octo/fix-auth" } },
    workspaces,
  );
  assert.equal(wt.workspaceTag, "octo/fix-auth");
  assert.doesNotMatch(wt.workspaceTag ?? "", INSIDE_WORDS);
  assert.deepEqual(wt.folders, [
    { id: "fld_api", label: "api", path: "/tmp/wt/api", revealable: true },
    { id: "fld_extra", label: "extra", path: "/tmp/wt/extra", revealable: false },
  ]);

  // Fallback copy when a worktree has no branch and its title carries the forbidden inside word:
  const untitledWt = resolveSessionFolders(projectFolders, { workspace: { id: "wrk_2", kind: "worktree", title: "Worktree" } }, workspaces);
  assert.equal(untitledWt.workspaceTag, "Isolated branch");
  assert.doesNotMatch(untitledWt.workspaceTag ?? "", INSIDE_WORDS);
  assert.equal(untitledWt.folders[0]?.path, "/Users/maya/code/api");
});
