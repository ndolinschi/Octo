import assert from "node:assert/strict";
import test from "node:test";
import { SPAWN_TOOL, acpCall, toolMeta, harnessTool } from "./tools";
import { locateInProject, looksLikeDiff, spawnInput, toolPath, writtenFiles, commandRuns } from "./toolsMore";

const folders = [
  { label: "infra", path: "/Users/maya/code/infra" },
  { label: "web", path: "/Users/maya/code/infra-web" },
];

test("ACP calls read as their title (verb + rest), never 'Called read'", () => {
  assert.deepEqual(toolMeta("read", { title: "Read README.md" }), { verb: "Read", arg: "README.md", folder: "" });
  assert.deepEqual(toolMeta("edit", { title: "Write acp-demo-note.md", locations: [] }), { verb: "Write", arg: "acp-demo-note.md", folder: "" });
  assert.deepEqual(toolMeta("tool", { title: "Thinking" }), { verb: "Thinking", arg: "", folder: "" });
  assert.equal(toolMeta("read_file", { path: "a.ts" }).verb, "Read");
  assert.equal(toolMeta("custom", { q: "x" }).verb, "Called custom");
});

test("locations map to the deepest project folder", () => {
  assert.deepEqual(locateInProject(folders, "/Users/maya/code/infra-web/src/a.ts"), { folder: "web", path: "src/a.ts" });
  assert.deepEqual(locateInProject(folders, "/Users/maya/code/infra/docs/x.md"), { folder: "infra", path: "docs/x.md" });
  assert.equal(locateInProject(folders, "/etc/hosts"), null);
  assert.deepEqual(acpCall("read", { title: "Read a", locations: [{ path: "/x", line: 3 }, { nope: 1 }] })?.locations, [{ path: "/x", line: 3 }]);
});

test("written files: write_file and ACP edits that did not fail", () => {
  const msgs = [
    {
      agent_id: "a",
      role: "assistant",
      created_at: "2026-11-10T10:00:00Z",
      content: [
        { type: "tool_use", id: "1", name: "write_file", input: { path: "./src/a.ts" } },
        { type: "tool_use", id: "2", name: "write_file", input: { folder: "web", path: "b.ts" } },
        { type: "tool_use", id: "3", name: "edit", input: { title: "Write c.md", locations: [{ path: "/Users/maya/code/infra/c.md" }] } },
        { type: "tool_use", id: "4", name: "read", input: { title: "Read d.md", locations: [{ path: "/Users/maya/code/infra/d.md" }] } },
        { type: "tool_use", id: "5", name: "write_file", input: { path: "fails.ts" } },
      ],
    },
    { agent_id: "a", role: "user", created_at: "2026-11-10T10:00:01Z", content: [{ type: "tool_result", tool_use_id: "5", content: "x", is_error: true }] },
  ];
  assert.deepEqual(
    writtenFiles(msgs, folders).map((w) => `${w.folder}/${w.path}`),
    ["infra/src/a.ts", "web/b.ts", "infra/c.md"],
  );
});

test("built-in tool rows: verb, main argument and folder", () => {
  assert.deepEqual(toolMeta("list_dir", {}), { verb: "Listed", arg: ".", folder: "" });
  assert.deepEqual(toolMeta("list_dir", { path: "src", folder: "web" }), { verb: "Listed", arg: "src", folder: "web" });
  assert.deepEqual(toolMeta("write_file", { path: "a.ts", folder: "api" }), { verb: "Wrote", arg: "a.ts", folder: "api" });
  assert.equal(toolMeta("bash", { command: "ls -la\necho hi" }).arg, "ls -la", "only the first line of a command");
  assert.deepEqual(toolMeta("save_note", { title: "Plan" }), { verb: "Saved note", arg: "Plan", folder: "" });
  assert.equal(toolMeta("delete_note", { id: "n1" }).arg, "n1", "falls back to the id");
  assert.equal(toolMeta("read_file", { path: 42 }).arg, "", "a non-string argument is not shown");
  assert.equal(toolMeta("read_file", null).verb, "Read");
});

test("an unknown tool reads as 'Called name' with its first string input", () => {
  assert.deepEqual(toolMeta("lookup", { n: 1, q: "term" }), { verb: "Called lookup", arg: "term", folder: "" });
  assert.deepEqual(toolMeta("lookup", undefined), { verb: "Called lookup", arg: "", folder: "" });
});

test("ACP titles: a leading verb is split off; a one-word or empty title stays whole", () => {
  assert.deepEqual(toolMeta("execute", { title: "Run npm test -- --watch" }), { verb: "Run", arg: "npm test -- --watch", folder: "" });
  assert.deepEqual(toolMeta("think", { title: "  Thinking  " }), { verb: "Thinking", arg: "", folder: "" });
  assert.deepEqual(toolMeta("other", { title: "" }), { verb: "Tool call", arg: "", folder: "" });
  assert.equal(toolMeta("read", { path: "a.ts" }).verb, "Called read", "an ACP kind without a title is not an ACP call");
});

test("acpCall: only ACP kinds with a title; bad locations are dropped", () => {
  assert.equal(acpCall("write_file", { title: "x" }), null);
  assert.equal(acpCall("read", "text"), null);
  assert.equal(acpCall("read", null), null);
  assert.deepEqual(acpCall("read", { title: "t", locations: "nope" }), { title: "t", locations: [] });
  assert.deepEqual(acpCall("read", { title: "t", locations: [null, { path: 3 }, { path: "/a", line: "x" }] })?.locations, [{ path: "/a" }]);
});

test("locateInProject: relative paths go to the first folder, Windows paths and trailing slashes work", () => {
  const f = [{ label: "win", path: "C:\\code\\app\\" }];
  assert.deepEqual(locateInProject(f, "./src/a.ts"), { folder: "win", path: "src/a.ts" });
  assert.deepEqual(locateInProject(f, "C:\\code\\app\\src\\a.ts"), { folder: "win", path: "src/a.ts" });
  assert.equal(locateInProject(f, "C:/code/app"), null, "the folder root itself is not a file");
  assert.equal(locateInProject(f, "C:/code/apple/x.ts"), null, "a sibling that shares a prefix is outside");
  assert.equal(locateInProject([], "a.ts"), null);
});

test("written files: a result for another tool call does not cancel a write, errors only cancel their own", () => {
  const msgs = [
    {
      agent_id: "a",
      role: "assistant",
      created_at: "2026-11-10T10:00:00Z",
      content: [
        { type: "tool_use", id: "w1", name: "write_file", input: { path: "ok.ts" } },
        { type: "tool_use", id: "w2", name: "write_file", input: { path: "bad.ts" } },
        { type: "tool_use", id: "w3", name: "write_file", input: { folder: "ghost", path: "x.ts" } },
        { type: "tool_use", id: "w4", name: "write_file", input: { path: "" } },
      ],
    },
    {
      agent_id: "a",
      role: "user",
      created_at: "2026-11-10T10:00:01Z",
      content: [
        { type: "tool_result", tool_use_id: "w1", content: "ok", is_error: false },
        { type: "tool_result", tool_use_id: "w2", content: "no", is_error: true },
      ],
    },
  ];
  assert.deepEqual(
    writtenFiles(msgs, folders).map((w) => w.path),
    ["ok.ts"],
    "unknown folder and empty path are ignored",
  );
  assert.deepEqual(writtenFiles([], folders), []);
  assert.deepEqual(writtenFiles(msgs, []), []);
});

test("toolPath and spawnInput tolerate odd input", () => {
  assert.equal(toolPath("read_file", { path: "a.ts" }), "a.ts");
  assert.equal(toolPath("bash", { path: "a.ts" }), "");
  assert.equal(toolPath("read_file", null), "");
  assert.deepEqual(spawnInput({ role: "coder", title: "T", task: "do", tier: "fast", extra: 1 }), { role: "coder", title: "T", task: "do", tier: "fast" });
  assert.deepEqual(spawnInput("junk"), { role: "", title: "", task: "", tier: "" });
  assert.equal(SPAWN_TOOL, "spawn_agent");
});

test("diff detection: hunks or headers plus change lines", () => {
  assert.equal(looksLikeDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new"), true);
  assert.equal(looksLikeDiff("@@ -1 +1 @@\n+added"), true);
  assert.equal(looksLikeDiff("- a list item\n- another"), false, "a Markdown list is not a diff");
  assert.equal(looksLikeDiff('{ "path": "x" }'), false);
});

test("commandRuns finds bash and ACP execute calls", () => {
  const at = "2026-11-11T10:00:00Z";
  const runs = commandRuns([
    { role: "assistant", created_at: at, content: [{ type: "tool_use", id: "1", name: "bash", input: {} }] },
    { role: "assistant", created_at: "x", content: [{ type: "tool_use", id: "2", name: "read_file", input: {} }] },
    { role: "assistant", created_at: "y", content: [{ type: "tool_use", id: "3", name: "execute", input: { title: "Run tests" } }] },
    { role: "user", created_at: "z", content: [{ type: "tool_use", id: "4", name: "bash", input: {} }] },
  ]);
  assert.deepEqual(runs, [at, "y"]);
});

test("harnessTool reads MCP-prefixed harness tools as the built-in ones", () => {
  assert.equal(harnessTool("mcp__octo-harness__spawn_agent"), "spawn_agent");
  assert.equal(harnessTool("octo-harness:save_note"), "save_note");
  assert.equal(harnessTool("mcp__octo-harness__delete_note"), "delete_note");
  assert.equal(harnessTool("spawn_agent"), "spawn_agent");
  assert.equal(harnessTool("mcp__github__create_issue"), "mcp__github__create_issue");
  assert.equal(harnessTool("my_spawn_agent"), "my_spawn_agent");
  assert.equal(toolMeta("mcp__octo-harness__save_note", { title: "Plan" }).verb, "Saved note");
});
