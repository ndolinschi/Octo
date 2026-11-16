import assert from "node:assert/strict";
import test from "node:test";
import {
  callRow,
  callSummary,
  callTimes,
  commandOf,
  editView,
  exitLabel,
  firstChangedLine,
  foldedRows,
  groupProblems,
  groupState,
  groupSummary,
  groupShortSummary,
  leadingColumns,
  mergeRuns,
  inputPairs,
  isRefusal,
  lineDiff,
  parseAcpDiff,
  placeRows,
  previewRows,
  readTarget,
  resultCount,
  skillNameOf,
  stoppedLine,
  tailLines,
  toolKind,
  turnIdAt,
  unwrapSkillContent,
  viewState,
} from "./toolView";

const REFUSAL =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

test("toolKind: built-in and ACP calls by kind", () => {
  assert.equal(toolKind("bash", { command: "ls" }), "shell");
  assert.equal(toolKind("execute", { title: "Run ls" }), "shell");
  assert.equal(toolKind("read_file", { path: "a" }), "read");
  assert.equal(toolKind("read", { title: "Read a" }), "read");
  assert.equal(toolKind("edit", { path: "a", old_string: "x", new_string: "y" }), "edit");
  assert.equal(toolKind("edit", { title: "Edit a" }), "edit");
  assert.equal(toolKind("write_file", { path: "a", content: "" }), "edit");
  assert.equal(toolKind("search", { title: "Search x" }), "search");
  assert.equal(toolKind("search_issues", { query: "x" }), "search");
  assert.equal(toolKind("save_note", { title: "x" }), "other");
});

test("refusals read as stopped, never failed; real errors stay errors", () => {
  assert.equal(isRefusal({ content: REFUSAL, is_error: true }), true);
  assert.equal(isRefusal({ content: "Denied by the user: not now", is_error: true }), true);
  assert.equal(isRefusal({ content: "ls: nope: No such file", is_error: true }), false);
  assert.equal(isRefusal({ content: REFUSAL, is_error: false }), false);
  assert.equal(viewState("error", { content: REFUSAL, is_error: true }), "stopped");
  assert.equal(viewState("error", { content: "boom", is_error: true }), "error");
});

test("stoppedLine: one plain sentence, never the agent's text", () => {
  assert.equal(stoppedLine({ content: REFUSAL, is_error: true }, "cancelled", "11:39"), "Stopped by you at 11:39.");
  assert.equal(stoppedLine({ content: REFUSAL, is_error: true }, null, "11:39"), "Declined at 11:39. It did not run.");
  assert.equal(stoppedLine({ content: "Denied by the user: use staging", is_error: true }, null, ""), "Declined by you — “use staging”. It did not run.");
  assert.equal(
    stoppedLine({ content: "interrupted: the tool call did not complete.", is_error: true }, "failed", "09:02"),
    "Interrupted at 09:02 — the request ended before this finished.",
  );
  assert.equal(stoppedLine({ content: "interrupted: the tool call did not complete.", is_error: true }, null, "09:02"), "Stopped at 09:02 before it finished.");
  assert.equal(stoppedLine(undefined, null, ""), "Stopped before it finished.");
  for (const s of [stoppedLine({ content: REFUSAL, is_error: true }, null, "")]) assert.doesNotMatch(s, /STOP|doesn't want/);
});

test("commands: the command line and the exit in words", () => {
  assert.equal(commandOf("bash", { command: "pnpm test" }), "pnpm test");
  assert.equal(commandOf("execute", { title: "Run terraform fmt", raw_input: { command: "terraform fmt -check" } }), "terraform fmt -check");
  assert.equal(commandOf("execute", { title: "Run make" }), "make");
  assert.equal(exitLabel("done", "ok"), "Exited 0");
  assert.equal(exitLabel("error", "boom\nexit status 2"), "Failed (exit 2)");
  assert.equal(exitLabel("error", " ELIFECYCLE  Command failed with exit code 1."), "Failed (exit 1)");
  assert.equal(exitLabel("error", "boom"), "Failed");
  assert.equal(exitLabel("stopped", ""), "Stopped");
  const t = tailLines("a\nb\nc\nd\n", 2);
  assert.deepEqual(t, { lines: ["c", "d"], hidden: 2, total: 4 });
});

test("reads: path and lines", () => {
  const r = readTarget("read_file", { folder: "api", path: "src/x.ts", offset: 1, limit: 40 });
  assert.deepEqual(r, { path: "src/x.ts", folder: "api", start: 1, end: 40 });
  const acp = readTarget("read", { title: "Read x", locations: [{ path: "/a/x.ts", line: 12 }] });
  assert.equal(acp?.path, "/a/x.ts");
  assert.equal(acp?.start, 12);
});

test("lineDiff numbers lines and keeps common ends as context", () => {
  const rows = lineDiff("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
  assert.deepEqual(
    rows.map((r) => `${r.kind[0]}${r.old ?? "-"}/${r.new ?? "-"}:${r.text}`),
    ["c1/1:a", "d2/-:b", "a-/2:B", "c3/3:c", "c4/4:d", "a-/5:e"],
  );
  assert.equal(firstChangedLine(rows), 2);
  assert.equal(firstChangedLine(lineDiff("a\nb\n", "a\n")), 2);
  assert.equal(firstChangedLine(lineDiff("a\n", "a\n")), null);
});

test("lineDiff stays bounded on large inputs", () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join("\n");
  const t = performance.now();
  const rows = lineDiff(a, b);
  assert.equal(rows.length, 4000);
  assert.ok(performance.now() - t < 500);
});

test("previewRows: first changes with context, at most max rows, gaps between far changes", () => {
  const before = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join("\n");
  const after = before.replace("l5", "L5").replace("l30", "L30");
  const rows = lineDiff(before, after);
  const p = previewRows(rows, 12, 2);
  const kinds = p.rows.map((r) => r.kind);
  assert.ok(kinds.includes("gap"));
  assert.equal(p.rest, 0);
  const small = previewRows(rows, 4, 2);
  assert.equal(small.rows.length, 4);
  assert.equal(small.rest, 2);
  assert.ok(foldedRows(rows).rows.length < rows.length);
  assert.deepEqual(
    placeRows([{ kind: "add", text: "x", old: null, new: 1 }], 10).map((r) => r.new),
    [10],
  );
});

test("editView: built-in edit, write_file and an ACP diff", () => {
  const e = editView("edit", { folder: "api", path: "src/r.ts", old_string: "retries: 2", new_string: "retries: 5" }, "edited src/r.ts");
  assert.ok(e);
  assert.equal(e.placed, false);
  assert.equal(e.needle, "retries: 5");
  assert.deepEqual([e.added, e.removed], [1, 1]);
  const w = editView("write_file", { path: "n.md", content: "a\nb\n" }, "wrote");
  assert.deepEqual([w?.added, w?.removed, w?.placed], [2, 0, true]);
  const acp = editView(
    "edit",
    { title: "Edit c.ts", locations: [{ path: "/p/c.ts", line: 5 }] },
    "diff /p/c.ts\n-  const res = await fetch(url);\n+  const res = await fetch(url, opts);",
  );
  assert.equal(acp?.placed, true);
  assert.equal(acp?.path, "/p/c.ts");
  assert.equal(acp?.rows[0]?.old, 5);
  assert.deepEqual(parseAcpDiff("diff /a\n+x"), [{ path: "/a", before: "", after: "x" }]);
  assert.equal(editView("edit", { title: "Edit" }, "done"), null);
});

test("other calls: a summary and tidy pairs", () => {
  assert.equal(callSummary("search", "search_issues", { query: "retry", team: "API" }, '[{"id":1},{"id":2}]'), "Searched for “retry” in API · 2 results");
  assert.equal(callSummary("search", "grep", { pattern: "x", path: "src" }, "14 matches"), "Searched for “x” in src · 14 results");
  assert.equal(callSummary("fetch", "fetch", { title: "Fetch", raw_input: { url: "https://x.dev" } }, "…"), "Fetched https://x.dev");
  assert.equal(resultCount(""), 0);
  const pairs = inputPairs("search_issues", { query: "retry", limit: 5, filter: { state: "open" }, empty: "" });
  assert.deepEqual(
    pairs.map((p) => [p.key, p.value]),
    [
      ["query", "retry"],
      ["limit", "5"],
      ["filter", '{"state":"open"}'],
    ],
  );
});

test("callTimes: announcement and result times from any loaded transcript", () => {
  const a = [
    { created_at: "2026-11-14T11:36:00Z", content: [{ type: "tool_use", id: "t1" }] },
    { created_at: "2026-11-14T11:36:04Z", content: [{ type: "tool_result", tool_use_id: "t1" }] },
  ];
  assert.deepEqual(callTimes([undefined, a], "t1"), { start: "2026-11-14T11:36:00Z", end: "2026-11-14T11:36:04Z" });
  assert.deepEqual(callTimes([a], "nope"), { start: null, end: null });
});

test("turnIdAt: the last request sent before the call", () => {
  const m = [
    { id: 1, role: "user", created_at: "2026-11-14T10:00:00Z", content: [{ type: "text" }] },
    { id: 2, role: "assistant", created_at: "2026-11-14T10:00:05Z", content: [{ type: "tool_use" }] },
    { id: 3, role: "user", created_at: "2026-11-14T10:00:06Z", content: [{ type: "tool_result" }] },
    { id: 4, role: "user", created_at: "2026-11-14T11:00:00Z", content: [{ type: "text" }] },
  ];
  assert.equal(turnIdAt(m, "2026-11-14T10:00:05Z"), 1);
  assert.equal(turnIdAt(m, "2026-11-14T12:00:00Z"), 4);
  assert.equal(turnIdAt(m, "2026-11-14T09:00:00Z"), null);
  assert.equal(turnIdAt(m, null), null);
});

test("groupSummary: one phrase per kind, built-in and ACP together", () => {
  assert.equal(
    groupSummary([
      { name: "bash", input: { command: "a" } },
      { name: "bash", input: { command: "b" } },
      { name: "read_file", input: { path: "x" } },
      { name: "search_issues", input: { query: "q" } },
      { name: "edit", input: { path: "x", old_string: "a", new_string: "b" } },
      { name: "edit", input: { title: "Edit y" } },
      { name: "search", input: { title: "Search z" } },
      { name: "execute", input: { title: "Run z" } },
      { name: "mystery", input: {} },
    ]),
    "Ran 3 commands, read 1 file, ran 2 searches, edited 2 files, called 1 tool",
  );
  assert.equal(groupSummary([{ name: "save_note", input: { title: "a" } }]), "Saved 1 note");
});

test("groupSummary counts files for reads and edits: two edits of one file are one file", () => {
  assert.equal(
    groupSummary([
      { name: "edit", input: { path: "a.ts", old_string: "x", new_string: "y" } },
      { name: "edit", input: { path: "a.ts", old_string: "p", new_string: "q" } },
      { name: "edit", input: { title: "Edit b.ts", raw_input: { file_path: "/r/b.ts" } } },
      { name: "bash", input: { command: "ls" } },
      { name: "bash", input: { command: "ls" } },
    ]),
    "Edited 2 files, ran 2 commands",
  );
});

test("callRow: one grammar for built-in and ACP calls of a kind", () => {
  const locate = (p: string) => (p.startsWith("/r/") ? { folder: "api", path: p.slice(3) } : null);
  const row = (name: string, input: unknown) => {
    const r = callRow(name, input, locate);
    return [r.verb, r.object, r.mono, r.qualifier, r.folder].join("|");
  };
  assert.equal(row("bash", { folder: "api", command: "pnpm test\necho" }), "Ran|pnpm test|true||api");
  assert.equal(row("execute", { title: "Run git push", raw_input: { command: "git push" } }), "Ran|git push|true||");
  assert.equal(row("read_file", { folder: "api", path: "./src/x.ts" }), "Read|src/x.ts|true||api");
  assert.equal(row("read", { title: "Read x", locations: [{ path: "/r/src/x.ts" }] }), "Read|src/x.ts|true||api");
  assert.equal(row("edit", { folder: "api", path: "src/x.ts", old_string: "a", new_string: "b" }), "Edited|src/x.ts|true||api");
  assert.equal(row("edit", { title: "Edit src/x.ts", raw_input: { file_path: "/r/src/x.ts" } }), "Edited|src/x.ts|true||api");
  assert.equal(row("write_file", { folder: "api", path: "src/new.ts", content: "" }), "Wrote|src/new.ts|true||api");
  assert.equal(row("delete", { title: "Delete src/old.ts", locations: [{ path: "/r/src/old.ts" }] }), "Deleted|src/old.ts|true||api");
  assert.equal(
    row("search", { title: "Search for withRetry in src", raw_input: { pattern: "withRetry", path: "/r/src" } }),
    "Searched for|withRetry|true|in src|api",
  );
  assert.equal(row("search", { title: "Search for withRetry in src" }), "Searched for|withRetry|true|in src|");
  assert.equal(row("grep", { pattern: "TODO", path: "src" }), "Searched for|TODO|true|in src|");
  // Words stay in the UI face, quoted; a named tool says which.
  assert.equal(row("search_issues", { query: "retry limit" }), "Searched for|“retry limit”|false|with search_issues|");
  assert.equal(row("fetch", { title: "Fetch https://x.dev", raw_input: { url: "https://x.dev" } }), "Fetched|https://x.dev|true||");
  assert.equal(row("save_note", { title: "Plan" }), "Saved note|Plan|false||");
  assert.equal(row("mystery", { a: "b" }), "Called|mystery|true||");
  assert.equal(row("think", { title: "Thinking about the plan" }), "Thinking about the plan||false||");
});

test("mergeRuns: consecutive calls with one key merge; a call between them splits the run", () => {
  const key = (s: string) => (s.startsWith("e:") ? s : "");
  assert.deepEqual(mergeRuns(["e:a", "e:a", "r", "e:a", "e:b", "e:b"], key), [["e:a", "e:a"], ["r"], ["e:a"], ["e:b", "e:b"]]);
  assert.deepEqual(mergeRuns(["r", "r"], key), [["r"], ["r"]]);
});

test("groupState: the worst state only when every call ended that way; problems as a quiet suffix", () => {
  assert.equal(groupState(["done", "error", "stopped", "stopped"]), "done");
  assert.equal(groupState(["done", "running"]), "running");
  assert.equal(groupState(["stopped", "stopped"]), "stopped");
  assert.equal(groupState(["error", "error"]), "error");
  assert.equal(groupState(["error", "stopped"]), "error");
  assert.equal(groupProblems(["done", "error", "stopped", "stopped"]), "1 failed · 2 stopped");
  assert.equal(groupProblems(["done"]), "");
});

test("3: a call a restart interrupted says so in its plain line, and the group counts it as interrupted", () => {
  const closed = { content: "interrupted: the tool call did not complete", is_error: true };
  assert.equal(stoppedLine(closed, "failed", "11:39", true), "Interrupted at 11:39 — Octo's local service restarted before this finished.");
  assert.equal(stoppedLine(closed, "failed", ""), "Interrupted — the request ended before this finished.");
  assert.equal(groupProblems(["done", "stopped", "error"], "interrupted"), "1 failed · 1 interrupted");
  assert.equal(groupProblems(["stopped"]), "1 stopped");
});

test("groupShortSummary: the two largest kinds in the order they ran, file changes together, the rest as one count", () => {
  const uses = [
    ...["a", "b", "c", "d"].map((c) => ({ name: "bash", input: { command: c } })),
    { name: "read_file", input: { path: "r.ts" } },
    { name: "search_issues", input: { query: "q" } },
    { name: "search_issues", input: { query: "p" } },
    ...["e1.ts", "e2.ts", "e3.ts"].map((p) => ({ name: "edit", input: { path: p, old_string: "x", new_string: "y" } })),
    { name: "write_file", input: { path: "w.ts", content: "" } },
    { name: "delete", input: { title: "Delete d.ts", raw_input: { file_path: "/r/d.ts" } } },
  ];
  assert.equal(groupShortSummary(uses), "4 commands, 5 edits, +3");
  assert.equal(groupShortSummary([{ name: "bash", input: { command: "ls" } }]), "1 command");
  assert.equal(
    groupShortSummary([
      { name: "read_file", input: { path: "a" } },
      { name: "bash", input: { command: "ls" } },
    ]),
    "1 read, 1 command",
  );
});

test("leadingColumns: spaces count one, a tab reaches the next stop", () => {
  assert.equal(leadingColumns("    x"), 4);
  assert.equal(leadingColumns("\tx"), 8);
  assert.equal(leadingColumns("  \tx", 4), 4);
  assert.equal(leadingColumns("x  "), 0);
  assert.equal(leadingColumns(""), 0);
});

test("skill calls: show loaded skill name and unwrap skill_content markdown", () => {
  assert.equal(toolKind("skill", { id: "brainstorming" }), "skill");
  assert.equal(toolKind("other", { title: "skill", raw_input: { id: "brainstorming" } }), "skill");
  assert.equal(skillNameOf("other", { title: "skill", raw_input: { id: "brainstorming" } }), "brainstorming");
  assert.equal(skillNameOf("skill", {}, '<skill_content name="using-git-worktrees">\n# Title\n</skill_content>'), "using-git-worktrees");

  const r = callRow("other", { title: "skill", raw_input: { id: "brainstorming" } }, () => null);
  assert.deepEqual([r.verb, r.object, r.mono, r.qualifier, r.folder], ["Loaded skill", "brainstorming", true, "", ""]);

  assert.equal(
    groupSummary([
      { name: "other", input: { title: "skill", raw_input: { id: "brainstorming" } } },
      { name: "skill", input: { id: "tdd" } },
    ]),
    "Loaded 2 skills",
  );
  assert.equal(groupShortSummary([{ name: "skill", input: { id: "tdd" } }]), "1 skill");

  const unwrapped = unwrapSkillContent('<skill_content name="brainstorming">\n# Heading\nBody text\n</skill_content>\n');
  assert.equal(unwrapped.name, "brainstorming");
  assert.equal(unwrapped.markdown, "# Heading\nBody text");
  assert.deepEqual(unwrapSkillContent("# Plain markdown\nHello"), { name: null, markdown: "# Plain markdown\nHello" });
});
