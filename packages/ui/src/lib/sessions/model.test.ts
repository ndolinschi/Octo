import type { ProjectSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedText,
  canDelete,
  deleteCopy,
  hasNoRequests,
  sessionStateWord,
  currentTitle,
  earlierSession,
  filterCounts,
  glyphOf,
  isWorking,
  stateWord,
  hasSeveral,
  isCompact,
  sessionErrorText,
  sessionRow,
  sidebarSessions,
  toggleOpen,
  transcriptSession,
  visibleNodes,
} from "./model";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const s = (id: string, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  kind: "main",
  title: id,
  state: "idle",
  model: "",
  started_at: "2026-11-12T09:00:00Z",
  last_activity_at: "2026-11-12T09:30:00Z",
  exchanges: 2,
  children: 0,
  current: false,
  archived: false,
  can_message: false,
  ...over,
});
const agent = (id: string, parent: string, over: Partial<ProjectSession> = {}): ProjectSession =>
  s(id, { kind: "agent", parent_session_id: parent, exchanges: 0, ...over });

const list = [
  s("m1", { started_at: "2026-11-10T09:00:00Z" }),
  s("m2", { started_at: "2026-11-11T09:00:00Z", children: 2 }),
  s("m3", { started_at: "2026-11-12T09:00:00Z", current: true, state: "working", children: 1 }),
  s("m0", { started_at: "2026-11-09T09:00:00Z", archived: true }),
  agent("a1", "m2", { started_at: "2026-11-11T09:10:00Z" }),
  agent("a2", "m2", { started_at: "2026-11-11T09:05:00Z", state: "failed" }),
  agent("a3", "m3", { started_at: "2026-11-12T09:20:00Z", state: "working" }),
  agent("a4", "m0", { started_at: "2026-11-09T09:20:00Z", archived: true }),
];

test("All: main sessions newest first, each with its agents oldest first, archived left out", () => {
  const nodes = visibleNodes(list, "all");
  assert.deepEqual(
    nodes.map((n) => n.session.id),
    ["m3", "m2", "m1"],
  );
  assert.deepEqual(
    nodes[1]?.children.map((c) => c.id),
    ["a2", "a1"],
  );
});

test("Mine lists the main sessions alone; Agents only running agent sessions; Archived both kinds", () => {
  assert.ok(visibleNodes(list, "mine").every((n) => n.children.length === 0 && n.session.kind === "main"));
  assert.deepEqual(
    visibleNodes(list, "agents").map((n) => n.session.id),
    ["a3"],
  );
  assert.deepEqual(
    visibleNodes(list, "archived").map((n) => n.session.id),
    ["a4", "m0"],
  );
});

test("Working keeps the working main session and an idle one only for its working agents", () => {
  const nodes = visibleNodes([...list, agent("a5", "m1", { state: "waiting" })], "working");
  assert.deepEqual(
    nodes.map((n) => [n.session.id, n.children.map((c) => c.id)]),
    [
      ["m3", ["a3"]],
      ["m1", ["a5"]],
    ],
  );
  assert.deepEqual(visibleNodes([s("x")], "working"), []);
});

test("counts per filter", () => {
  assert.deepEqual(filterCounts(list), { all: 3, working: 2, mine: 3, agents: 1, archived: 2 });
});

test("glyphs: waiting needs you, stopped rests", () => {
  assert.equal(glyphOf("working"), "working");
  assert.equal(glyphOf("waiting"), "needs");
  assert.equal(glyphOf("failed"), "failed");
  assert.equal(glyphOf("stopped"), "stopped");
});

test("row: day, exchanges and model on the second line; 'default' or the last activity at the right", () => {
  const name = (v: string) => (v === "opus" ? "Opus 5.5" : v);
  const row = sessionRow(s("m3", { title: "Plan the release", model: "opus", exchanges: 5, current: true }), NOW, name);
  assert.equal(row.description, "5 requests · Opus 5.5");
  assert.equal(row.tail, "default");
  assert.equal(sessionRow(s("m1", { last_activity_at: "2026-11-11T09:00:00Z" }), NOW, name).tail, "Yesterday");
  const a = sessionRow(agent("a1", "m2", { model: "haiku", title: "Map the repository" }), NOW, name);
  assert.equal(a.description, "Idle · haiku");
  const live = sessionRow(agent("a3", "m3", { model: "opus", state: "working", title: "Inspect logs" }), NOW, name, {
    role: "Code explorer",
    statusText: "Reading files…",
    glyph: "working",
    tail: "12s",
  });
  assert.equal(live.description, "Code explorer · Reading files… · Opus 5.5");
  assert.equal(live.glyph, "working");
  assert.equal(live.tail, "12s");
  assert.equal(sessionRow(s("e", { title: " " }), NOW, name).title, "New session");
});

test("the composer note: the harness's sentence, else the reason by code, none when it can send", () => {
  assert.equal(blockedText({ can_message: true }), null);
  assert.equal(
    blockedText({ can_message: false, message_blocked: { code: "not_current", message: "Resume this session to continue it" } }),
    "Resume this session to continue it.",
  );
  assert.equal(blockedText({ can_message: false, message_blocked: { code: "not_running", message: "" } }), "This agent has finished and can't be continued.");
  assert.equal(blockedText({ can_message: false }), "This session can't take a message now.");
});

test("error codes read as plain words; an unknown code keeps the harness's message", () => {
  assert.equal(sessionErrorText("turn_in_progress", "x"), "Wait for the current request to finish, or stop it.");
  assert.match(sessionErrorText("current_session", "x"), /default session/);
  assert.match(sessionErrorText("session_running", "x"), /Stop it first/);
  assert.match(sessionErrorText("not_continuable", "x"), /can't be continued/);
  assert.match(sessionErrorText("steer_unsupported", "x"), /can't take a message while it works/);
  assert.equal(sessionErrorText("weird", "disk full"), "disk full. Try again.");
});

test("the conversation tab follows the current session's title", () => {
  assert.equal(currentTitle(list, "m3", "fallback"), "m3");
  assert.equal(currentTitle(list, null, "fallback"), "fallback");
  assert.equal(currentTitle([s("m3", { title: "  " })], "m3", "fallback"), "fallback");
});

test("only a resumed session loads the conversation by id", () => {
  assert.equal(transcriptSession(list, "m3"), undefined);
  assert.equal(transcriptSession(list, "m2"), "m2");
  assert.equal(transcriptSession(list, null), undefined);
  assert.equal(transcriptSession(list, "a1"), undefined);
});

test("sidebar: five most recent, 'more' past five; two main sessions make a project expandable", () => {
  const many = Array.from({ length: 7 }, (_, i) => s(`m${i}`, { started_at: `2026-11-0${i + 1}T09:00:00Z` }));
  const side = sidebarSessions(many);
  assert.equal(side.shown.length, 5);
  assert.equal(side.shown[0]?.id, "m6");
  assert.equal(side.more, true);
  assert.equal(sidebarSessions(many.slice(0, 5)).more, false);
  assert.equal(hasSeveral([s("a")]), false);
  assert.equal(hasSeveral([s("a"), s("b")]), true);
});

test("Agents can be limited to the running agent sessions of one main session", () => {
  assert.deepEqual(
    visibleNodes(list, "agents", "m2").map((n) => n.session.id),
    [],
  );
  assert.deepEqual(
    visibleNodes(list, "agents", "m3").map((n) => n.session.id),
    ["a3"],
  );
  assert.equal(visibleNodes(list, "agents", null).length, 1);
  assert.equal(visibleNodes(list, "all", "m2").length, 3);
});

test("a pane under the conversation's floor is compact; an unmeasured one is not", () => {
  assert.equal(isCompact(270), true);
  assert.equal(isCompact(419), true);
  assert.equal(isCompact(420), false);
  assert.equal(isCompact(0), false);
});

test("the boundary marker names the earlier session: the harness's title, else the one before", () => {
  const m3 = list.find((x) => x.id === "m3");
  assert.ok(m3);
  assert.deepEqual(earlierSession(list, m3), { id: "m2", title: "m2" });
  assert.deepEqual(earlierSession(list, m3, "Cleared one"), { id: "m2", title: "Cleared one" });
  const oldest = list.find((x) => x.id === "m0");
  assert.ok(oldest);
  assert.equal(earlierSession(list, oldest), null);
  const only = s("only", { started_at: "2026-11-12T10:00:00Z" });
  assert.deepEqual(earlierSession([only], only, "Marker"), { id: null, title: "Marker" });
});

test("one open row at a time", () => {
  assert.equal(toggleOpen(null, "a"), "a");
  assert.equal(toggleOpen("a", "a"), null);
  assert.equal(toggleOpen("a", "b"), "b");
});

test("Delete: not the current session, nothing running in it or in its agents", () => {
  const get = (id: string) => {
    const x = list.find((y) => y.id === id);
    assert.ok(x);
    return x;
  };
  assert.equal(canDelete(list, get("m3")), false); // current
  assert.equal(canDelete(list, get("m2")), true);
  assert.equal(canDelete(list, get("a1")), true);
  assert.equal(canDelete(list, get("a3")), false); // running agent
  const busyChild = [s("p", { children: 1 }), agent("c", "p", { state: "working" })];
  assert.equal(canDelete(busyChild, busyChild[0] ?? s("x")), false);
});

test("an empty session says it has no requests; working comes from a running turn only", () => {
  const fresh = s("f", { exchanges: 0, current: true });
  assert.equal(hasNoRequests(fresh), true);
  assert.equal(sessionStateWord(fresh), "No requests yet");
  assert.equal(sessionRow(fresh, NOW, (v) => v).description.includes("No requests yet"), true);
  const running = s("r", { exchanges: 0, current: true, state: "working" });
  assert.equal(sessionStateWord(running), "Working");
  assert.equal(sessionRow(running, NOW, (v) => v).description.includes("First request running"), true);
  assert.equal(sessionStateWord(s("d")), "Idle");
});

test("the delete confirmation says what goes and what stays", () => {
  assert.match(deleteCopy({ kind: "main" }).description, /transcript.*agents.*remembered.*stays/);
  assert.match(deleteCopy({ kind: "agent" }).title, /agent session/);
});

test("parallel sessions: queued is its own state (dashed ring, its words), counts as at work, and the default is not deletable", () => {
  assert.equal(glyphOf("queued"), "queued");
  assert.equal(stateWord("queued"), "Waiting to start");
  assert.equal(isWorking({ state: "queued" }), true);
  const d = s("d", { default: true, current: true });
  assert.equal(canDelete([d], d), false);
  assert.equal(canDelete([d], s("x", { default: false })), true);
});

test("visibleNodes and filterCounts hide untouched empty default sessions while keeping working or queued ones", () => {
  const emptyDef = s("empty-def", { title: "", exchanges: 0, current: true, default: true });
  const queuedEmpty = s("queued-empty", { title: "", exchanges: 0, queued: 1 });
  const workingEmpty = s("working-empty", { title: "", exchanges: 0, state: "working" });
  assert.deepEqual(visibleNodes([emptyDef], "all"), []);
  assert.deepEqual(visibleNodes([emptyDef], "mine"), []);
  assert.deepEqual(filterCounts([emptyDef]), { all: 0, working: 0, mine: 0, agents: 0, archived: 0 });
  assert.deepEqual(
    visibleNodes([emptyDef, queuedEmpty, workingEmpty], "all").map((n) => n.session.id),
    ["queued-empty", "working-empty"],
  );
  assert.equal(filterCounts([emptyDef, queuedEmpty, workingEmpty]).all, 2);
});
