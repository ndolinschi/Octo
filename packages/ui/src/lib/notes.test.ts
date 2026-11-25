import assert from "node:assert/strict";
import test from "node:test";
import type { Note } from "@octo/agent-client";
import { autoDescription, filterNotes, indexFooter, noteFileName, noteIndex, noteLine, parseTags, pinState, sortNotes, titleFromFileName } from "./notes";

function note(i: number, over: Partial<Note> = {}): Note {
  const n = String(i).padStart(3, "0");
  return {
    id: `nte_${n}`,
    title: `Topic ${n}`,
    description: `How topic ${n} works and when it matters for the release plan of the project`,
    description_auto: false,
    tags: ["area"],
    pinned: false,
    size: 100,
    author: "user",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
    last_read_at: "",
    read_count: 0,
    ...over,
  };
}

const hundred = Array.from({ length: 100 }, (_, i) => note(i));

test("autoDescription: first non-empty line, 200 characters", () => {
  assert.equal(autoDescription("\n\n  first  \nsecond"), "first");
  assert.equal(autoDescription(""), "");
  assert.equal(Array.from(autoDescription("я".repeat(300))).length, 200);
});

test("the index of 100 notes fits 1 500 tokens: pinned first, then recent reads, then a count of the rest", () => {
  const notes = hundred.map((n) => (n.id === "nte_010" ? { ...n, pinned: true } : n.id === "nte_020" ? { ...n, last_read_at: "2027-01-01T00:00:00.000Z" } : n));
  const idx = noteIndex(notes);
  assert.equal(idx.listed[0]?.id, "nte_010");
  assert.equal(idx.listed[1]?.id, "nte_020");
  assert.ok(idx.more > 0 && idx.listed.length + idx.more === 100);
  assert.ok(idx.tokens <= 1500, String(idx.tokens));
  const footer = indexFooter(notes);
  assert.match(footer.text, /find the rest by searching\.$/);
  assert.doesNotMatch(footer.text, /\d/);
  assert.match(
    footer.tip,
    /^Agents see a list of \d+ notes \(about [\d,]+ tokens\) and read a note in full only when they need it\. \d+ more are found by search\.$/,
  );
});

test("a few notes are all listed", () => {
  const idx = noteIndex(hundred.slice(0, 5));
  assert.equal(idx.more, 0);
  assert.equal(idx.listed.length, 5);
  assert.match(indexFooter(hundred.slice(0, 1)).tip, /a list of 1 note \(/);
  assert.equal(indexFooter(hundred.slice(0, 1)).text, "Agents see a short list of these notes and open one when it is relevant.");
});

test("pin limits: three notes, 2 000 characters together", () => {
  const pinned = [note(1, { pinned: true, size: 600 }), note(2, { pinned: true, size: 600 })];
  assert.equal(pinState(pinned, { size: 500 }).canPin, true);
  const three = [...pinned, note(3, { pinned: true, size: 10 })];
  assert.match(pinState(three, { size: 1 }).reason, /Only 3 notes/);
  assert.equal(pinState(three, { id: "nte_003", size: 700 }).canPin, true, "re-saving a pinned note replaces its own size");
  assert.match(pinState(pinned, { size: 900 }).reason, /2,000 characters together; these would be 2,100/);
});

test("filter, tags, file names, order", () => {
  assert.equal(filterNotes(hundred, "topic 042").length, 1);
  assert.equal(filterNotes(hundred, "").length, 100);
  assert.deepEqual(parseTags(" a, b c,,a ,"), ["a", "b c"]);
  assert.equal(noteFileName("Бюджет: Q4!"), "бюджет-q4.md");
  assert.equal(noteFileName("???"), "note.md");
  assert.equal(titleFromFileName("deploy-notes.md"), "deploy notes");
  assert.deepEqual(
    sortNotes([note(1), note(2, { pinned: true }), note(3)]).map((n) => n.id),
    ["nte_002", "nte_003", "nte_001"],
  );
});

test("a note's list line: plain description (no heading marks), then its tags", () => {
  assert.equal(noteLine({ description: "# Migrations: history", tags: ["migrations", "history"] }), "Migrations: history · #migrations #history");
  assert.equal(noteLine({ description: "Rules", tags: [] }), "Rules");
  assert.equal(noteLine({ description: "", tags: ["x"] }), "No description · #x");
});
