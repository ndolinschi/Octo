import type * as Monaco from "monaco-editor";
import assert from "node:assert/strict";
import test from "node:test";
import { completionKind, documentation, toHoverContents, toLocations, toLspPosition, toMarkers, toMonacoRange, toProblems } from "./convert";

const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

/** Just the enums the converters read, with distinguishable values. */
const fakeMonaco = {
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  MarkerTag: { Unnecessary: 1, Deprecated: 2 },
  languages: { CompletionItemKind: new Proxy({}, { get: (_t, k) => String(k) }) },
} as unknown as typeof Monaco;

test("positions and ranges move between 0-based LSP and 1-based Monaco", () => {
  assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(toLspPosition({ lineNumber: 12, column: 5 }), { line: 11, character: 4 });
  assert.deepEqual(toMonacoRange(range(0, 0, 2, 3)), { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 4 });
});

test("diagnostics become problems (1-based line and column, severity names, string codes)", () => {
  const [p] = toProblems([{ range: range(4, 2, 4, 9), severity: 2, message: "unused", source: "ts", code: 6133, tags: [1] }]);
  assert.deepEqual(p, { severity: "warning", message: "unused", source: "ts", code: "6133", tags: [1], line: 5, column: 3, range: range(4, 2, 4, 9) });
});

test("diagnostics: missing severity is an error; unknown severity too; the four levels map", () => {
  const sev = (severity?: number) => toProblems([{ range: range(0, 0, 0, 1), message: "m", ...(severity === undefined ? {} : { severity }) }])[0]?.severity;
  assert.deepEqual([sev(), sev(1), sev(2), sev(3), sev(4), sev(99)], ["error", "error", "warning", "info", "hint", "error"]);
});

test("diagnostics: malformed entries are skipped, optional fields default", () => {
  assert.deepEqual(toProblems(null), []);
  assert.deepEqual(toProblems("nope"), []);
  const out = toProblems([
    null,
    3,
    { message: "no range" },
    { range: range(0, 0, 0, 1) },
    { range: { start: { line: "0" }, end: {} }, message: "bad" },
    { range: range(0, 0, 0, 1), message: "fine", code: null },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0]?.source, out[0]?.code, out[0]?.tags], [null, null, []]);
});

test("markers carry range, severity, source, code and mapped tags", () => {
  const problems = toProblems([
    { range: range(0, 0, 0, 3), severity: 1, message: "bad", source: "go", code: "E1", tags: [1, 2, 3] },
    { range: range(1, 0, 1, 1), severity: 4, message: "meh" },
  ]);
  const [a, b] = toMarkers(fakeMonaco, problems);
  assert.deepEqual(a, {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 4,
    severity: 8,
    message: "bad",
    source: "go",
    code: "E1",
    tags: [1, 2],
  });
  assert.deepEqual(
    b,
    { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2, severity: 1, message: "meh", tags: [] },
    "no source or code keys when absent",
  );
});

test("hover contents: strings, MarkupContent, MarkedString and arrays; empty parts drop out", () => {
  assert.deepEqual(toHoverContents("plain **md**"), [{ value: "plain **md**" }]);
  assert.deepEqual(toHoverContents("   "), []);
  assert.deepEqual(toHoverContents({ kind: "markdown", value: "# T" }), [{ value: "# T" }]);
  assert.deepEqual(toHoverContents({ language: "go", value: "func f()" }), [{ value: "```go\nfunc f()\n```" }]);
  assert.deepEqual(toHoverContents(["a", { language: "ts", value: "x" }, "", null, 5]), [{ value: "a" }, { value: "```ts\nx\n```" }]);
  assert.deepEqual(toHoverContents(null), []);
  assert.deepEqual(toHoverContents({ kind: "markdown", value: "" }), []);
});

test("plaintext hover is escaped so it cannot become markdown", () => {
  const [h] = toHoverContents({ kind: "plaintext", value: "a_b *c* [d](e) `f`" });
  assert.equal(h?.value, "a\\_b \\*c\\* \\[d\\]\\(e\\) \\`f\\`");
});

test("completion kinds are 1-based into Monaco's enum; unknown falls back to Text", () => {
  assert.equal(completionKind(fakeMonaco, 1), "Text");
  assert.equal(completionKind(fakeMonaco, 2), "Method");
  assert.equal(completionKind(fakeMonaco, 3), "Function");
  assert.equal(completionKind(fakeMonaco, 7), "Class");
  assert.equal(completionKind(fakeMonaco, 25), "TypeParameter");
  for (const k of [0, 26, -1, "3", null, undefined]) assert.equal(completionKind(fakeMonaco, k), "Text", String(k));
});

test("documentation: strings, markdown content, plain content, nothing", () => {
  assert.equal(documentation("text"), "text");
  assert.equal(documentation(""), undefined);
  assert.deepEqual(documentation({ kind: "markdown", value: "**b**" }), { value: "**b**" });
  assert.equal(documentation({ kind: "plaintext", value: "p" }), "p");
  assert.equal(documentation(null), undefined);
  assert.equal(documentation(7), undefined);
});

test("locations: Location, Location[], LocationLink[], null", () => {
  const r = range(1, 2, 3, 4);
  assert.deepEqual(toLocations({ uri: "file:///a", range: r }), [{ uri: "file:///a", range: r }]);
  assert.deepEqual(toLocations([{ uri: "file:///a", range: r }, { uri: "file:///b" }, null, "x"]), [{ uri: "file:///a", range: r }]);
  const sel = range(5, 5, 5, 6);
  assert.deepEqual(
    toLocations([{ targetUri: "file:///t", targetRange: r, targetSelectionRange: sel }]),
    [{ uri: "file:///t", range: sel }],
    "the selection range wins",
  );
  assert.deepEqual(toLocations([{ targetUri: "file:///t", targetRange: r }]), [{ uri: "file:///t", range: r }]);
  assert.deepEqual(toLocations([{ targetUri: "file:///t" }]), []);
  assert.deepEqual(toLocations(null), []);
  assert.deepEqual(toLocations(undefined), []);
});
