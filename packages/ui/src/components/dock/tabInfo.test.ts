import { emptyProjectState, withSessions, type ProjectState } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { agentTab, browserTab, CHAT, planTab, sessionTab, terminalTab, toolTab } from "../../state/workspace/layout";
import { GLYPH } from "../primitives/glyphs";
import { conversationLabel, tabInfo } from "./tabInfo";

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

test("tabInfo leaves browser page titles untruncated so Tab CSS handles one clean ellipsis", () => {
  const info = tabInfo(browserTab("default"), {
    state: emptyProjectState(),
    projectName: "Atlas API",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
    browser: () => ({ url: "http://localhost:5173/", title: "Atlas Console — Local Preview", pins: 0 }),
  });
  assert.equal(info.label, "Atlas Console — Local Preview");
  assert.equal(info.detail, "localhost:5173");
  assert.equal(info.name, "Atlas Console — Local Preview — http://localhost:5173/");
});

test("tabInfo formats singleton and multi-instance terminal tabs with shell and folder metadata", () => {
  const singleton = tabInfo(toolTab("terminal"), {
    state: emptyProjectState(),
    projectName: "Atlas API",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
    terminal: () => ({ shell: "zsh", folder: "atlas-api", title: "" }),
  });
  assert.equal(singleton.label, "zsh");
  assert.equal(singleton.detail, "atlas-api");
  assert.equal(singleton.icon, GLYPH.terminal);
  assert.equal(singleton.glyph, null);

  const extra = tabInfo(terminalTab("t2"), {
    state: emptyProjectState(),
    projectName: "Atlas API",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
    terminal: () => ({ shell: "", folder: "atlas-web", title: "" }),
  });
  assert.equal(extra.label, "Terminal");
  assert.equal(extra.detail, "atlas-web");
  assert.equal(extra.icon, GLYPH.terminal);
  assert.equal(extra.glyph, null);

  const second = tabInfo(terminalTab("t3"), {
    state: emptyProjectState(),
    projectName: "Atlas API",
    orchestratorId: "agt_1",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
    terminal: () => ({ shell: "zsh", folder: "proj", title: "", ordinal: 2 }),
  });
  assert.equal(second.label, "zsh");
  assert.equal(second.detail, "proj 2");
  assert.equal(second.name, "zsh · proj 2");
  assert.equal(second.title, "Terminal: zsh · proj 2");
});

test("conversationLabel drops the project prefix while the tabs belong to one project (decision F2)", () => {
  assert.deepEqual(conversationLabel("Atlas API", "Fix the flaky test", 1), { label: "Fix the flaky test" });
  assert.deepEqual(conversationLabel("Atlas API", "Fix the flaky test", 2), { label: "Atlas API", detail: "Fix the flaky test" });
  assert.deepEqual(conversationLabel("Atlas API", "", 1), { label: "Atlas API" });
  assert.deepEqual(conversationLabel("Atlas API", "Atlas API", 2), { label: "Atlas API" });
});

test("the chat tab is named by its topic, the tooltip and name keep the project", () => {
  const info = tabInfo(CHAT, {
    state: stateWithSession({ title: "Fix upload race" }),
    projectName: "Atlas",
    orchestratorId: "agt_1",
    chatSessionId: "ses_2",
    file: () => undefined,
    comments: () => 0,
    runStatus: () => null,
  });
  assert.equal(info.label, "Fix upload race");
  assert.equal(info.detail, undefined);
  assert.equal(info.name, "Atlas / Fix upload race");
  assert.match(info.title, /^Atlas: /);
});

test("an agent tab is the agent's label, its task in the tooltip (decision F4)", () => {
  const state = emptyProjectState();
  const a1 = {
    id: "a1",
    project_id: "p",
    parent_id: "root",
    depth: 1,
    role: "Dependency auditor",
    title: "Breaking changes 0.76 → 0.80",
    task: "List the breaking changes",
    model: "m",
    tier: null,
    status: "running",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: "2026-11-10T10:00:00Z",
    started_at: null,
    finished_at: null,
  } as const;
  const ctx = { state: { ...state, agents: { a1 } }, orchestratorId: "root", file: () => undefined, comments: () => 0, runStatus: () => null };
  const info = tabInfo(agentTab("a1"), ctx);
  assert.equal(info.label, "Dependency auditor");
  assert.equal(info.title, "Dependency auditor: Breaking changes 0.76 → 0.80");
  assert.equal(tabInfo(agentTab("gone"), ctx).label, "Agent");
});

test("a plan tab shows its title, icon and pending glyph", () => {
  const base = { state: emptyProjectState(), orchestratorId: "root", file: () => undefined, comments: () => 0, runStatus: () => null };
  const pending = tabInfo(planTab("pln_1"), {
    ...base,
    plan: () => ({
      title: "Plan: Add fallback method",
      plan: { status: "pending" },
    }),
  });
  assert.equal(pending.label, "Plan: Add fallback method");
  assert.equal(pending.icon, GLYPH.plan);
  assert.equal(pending.glyph, "needs");

  const approved = tabInfo(planTab("pln_1"), {
    ...base,
    plan: () => ({
      title: "Plan: Add fallback method",
      plan: { status: "approved" },
    }),
  });
  assert.equal(approved.glyph, null);
  assert.equal(approved.title, "Plan: Add fallback method (approved)");

  const fallback = tabInfo(planTab("pln_unknown"), base);
  assert.equal(fallback.label, "Plan");
  assert.equal(fallback.glyph, null);
});
