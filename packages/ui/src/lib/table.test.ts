import assert from "node:assert/strict";
import test from "node:test";
import { numericColumns, parseCsv, structured, toCsv, toMarkdown, MAX_ROWS } from "./table";

test("parseCsv handles quotes, doubled quotes and newlines in quotes", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",2\n'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["multi\nline", "2"],
  ]);
});

test("structured: CSV and JSON tables, pairs, and plain text", () => {
  const csv = structured("page,ms\nguide,1840\napi,1422");
  assert.equal(csv?.kind, "table");
  assert.deepEqual(csv?.kind === "table" ? csv.table.head : null, ["page", "ms"]);
  const json = structured(
    JSON.stringify([
      { page: "a", status: 404 },
      { page: "b", status: 410, extra: true },
    ]),
  );
  assert.deepEqual(json?.kind === "table" ? json.table : null, {
    head: ["page", "status", "extra"],
    rows: [
      ["a", "404", ""],
      ["b", "410", "true"],
    ],
    truncated: 0,
  });
  assert.deepEqual(structured('{"merchants": 1284, "mismatches": 0}'), {
    kind: "pairs",
    pairs: [
      ["merchants", "1284"],
      ["mismatches", "0"],
    ],
  });
  assert.equal(structured("Plan: 3 to add, 1 to change, 2 to destroy."), null);
  assert.equal(structured("a,b\nc"), null, "ragged rows");
  assert.equal(structured('[{"nested": {"x": 1}, "y": 2}]'), null, "not flat");
  assert.equal(structured('[{"only": 1}]'), null, "one column");
  assert.equal(structured("1,2\n3,4"), null, "numbers only: no header");
  assert.equal(structured(JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])))), null, "more than 8 pairs");
});

test("tables are capped at MAX_ROWS", () => {
  const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ a: i, b: "x" }));
  const s = structured(JSON.stringify(rows));
  assert.equal(s?.kind === "table" ? s.table.rows.length : 0, MAX_ROWS);
  assert.equal(s?.kind === "table" ? s.table.truncated : 0, 5);
});

test("numericColumns and export", () => {
  assert.deepEqual(
    numericColumns(
      [
        ["guide", "1,840", "—"],
        ["api", "1,422", "12%"],
      ],
      3,
    ),
    [false, true, true],
  );
  assert.equal(toMarkdown(["page", "ms"], [["a|b", "12"]]), "| page | ms |\n| --- | ---: |\n| a\\|b | 12 |");
  assert.equal(toCsv(["a", "b"], [["x, y", 'q"']]), 'a,b\n"x, y","q"""');
});
