import assert from "node:assert/strict";
import test from "node:test";
import { acpCall, locateInProject, toolMeta, writtenFiles } from "./tools";

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
