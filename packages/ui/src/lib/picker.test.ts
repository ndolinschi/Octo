import assert from "node:assert/strict";
import test from "node:test";
import { filterSections, pickerIndex, rowMatches } from "./picker";

test("pickerIndex wraps and starts from either end", () => {
  assert.equal(pickerIndex(-1, 3, 1), 0);
  assert.equal(pickerIndex(-1, 3, -1), 2);
  assert.equal(pickerIndex(2, 3, 1), 0);
  assert.equal(pickerIndex(0, 3, -1), 2);
  assert.equal(pickerIndex(0, 0, 1), -1);
});

test("rowMatches needs every word in the label or the detail", () => {
  const row = { label: "Sonnet 5.5", detail: "claude-sonnet-5-5" };
  assert.ok(rowMatches(row, ""));
  assert.ok(rowMatches(row, "son 5"));
  assert.ok(rowMatches(row, "claude sonnet"));
  assert.ok(!rowMatches(row, "opus"));
});

test("filterSections drops sections left empty", () => {
  const run = () => undefined;
  const out = filterSections(
    [
      { title: "Tools", rows: [{ id: "a", label: "Agents", run }] },
      { title: "Agents", rows: [{ id: "b", label: "Reviewer", run }] },
    ],
    "rev",
  );
  assert.deepEqual(
    out.map((s) => [s.title, s.rows.map((r) => r.id)]),
    [["Agents", ["b"]]],
  );
});
