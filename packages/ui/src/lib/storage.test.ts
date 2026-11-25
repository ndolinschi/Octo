import assert from "node:assert/strict";
import test from "node:test";
import { commentsCodec, isCodeComment } from "./comments";
import { PREFS, choiceCodec, jsonCodec, readPref, writePref, type Codec } from "./storage";
import { seenCodec } from "./seen";

/** A localStorage stand-in installed on `window.localStorage` for the helpers under test. */
function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => {
      if (broken) throw new Error("blocked");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("full");
      data.set(k, v);
    },
  };
  Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true, writable: true });
  return data;
}

test("every key is declared once: unique, prefixed by its kind, none a prefix of another", () => {
  const sample = [
    PREFS.theme,
    PREFS.seen,
    PREFS.layout("p1"),
    PREFS.fileTree("p1"),
    PREFS.comments("p1"),
    PREFS.layout("p2"),
    PREFS.fileTree("p2"),
    PREFS.comments("p2"),
  ];
  assert.equal(new Set(sample).size, sample.length, "distinct names per kind and per project");
  const kinds = [PREFS.theme, PREFS.seen, PREFS.layout(""), PREFS.fileTree(""), PREFS.comments("")];
  for (const a of kinds) for (const b of kinds) if (a !== b) assert.ok(!a.startsWith(b), `${a} must not start with ${b}`);
  assert.deepEqual(
    [PREFS.theme, PREFS.seen, PREFS.layout("p"), PREFS.fileTree("p"), PREFS.comments("p")],
    ["theme", "seen", "layout.p", "fileTree.p", "comments.p"],
    "the names stored since v6",
  );
});

test("keys are stored under the octo. prefix; a missing key reads null", () => {
  const data = fakeStorage();
  assert.equal(readPref(PREFS.theme), null);
  assert.equal(writePref(PREFS.theme, "dark"), true);
  assert.equal(data.get("octo.theme"), "dark");
  assert.equal(readPref(PREFS.theme), "dark");
});

test("unavailable storage reads null and swallows writes", () => {
  fakeStorage({}, true);
  assert.equal(readPref(PREFS.theme), null);
  assert.doesNotThrow(() => writePref(PREFS.theme, "dark"));
  assert.equal(writePref(PREFS.theme, "dark"), false);
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true, writable: true });
  assert.equal(readPref(PREFS.theme), null);
});

test("jsonCodec: valid text is validated, malformed or missing text gives the default", () => {
  const codec = jsonCodec((v) => (typeof v === "number" ? v : -1));
  assert.equal(codec.parse("7"), 7);
  assert.equal(codec.parse(null), -1);
  assert.equal(codec.parse("{not json"), -1);
  assert.equal(codec.parse('"7"'), -1);
  assert.equal(codec.stringify(7), "7");
});

test("choiceCodec: only listed values, plain text", () => {
  const codec: Codec<"a" | "b"> = choiceCodec(["a", "b"], "a");
  assert.equal(codec.parse("b"), "b");
  assert.equal(codec.parse("c"), "a");
  assert.equal(codec.parse(null), "a");
  assert.equal(codec.parse('"b"'), "a", "JSON-quoted text is not a choice");
  assert.equal(codec.stringify("b"), "b");
});

test("seen: a stored value from v6 loads unchanged; malformed starts fresh", () => {
  const stored = '{"since":"2026-11-01T10:00:00.000Z","projects":{"p1":"2026-11-02T09:00:00Z"}}';
  assert.deepEqual(seenCodec.parse(stored), { since: "2026-11-01T10:00:00.000Z", projects: { p1: "2026-11-02T09:00:00Z" } });
  assert.equal(seenCodec.stringify(seenCodec.parse(stored)), stored, "byte-identical round trip");
  for (const bad of [null, "", "{", "[]", "null", '{"since":1,"projects":{}}', '{"since":"x"}', '{"since":"x","projects":null}']) {
    const fresh = seenCodec.parse(bad);
    assert.deepEqual(fresh.projects, {}, String(bad));
    assert.ok(!Number.isNaN(Date.parse(fresh.since)), "since is a real time");
  }
  assert.deepEqual(seenCodec.parse('{"since":"s","projects":{"a":"t","b":3}}').projects, { a: "t" }, "non-string entries are dropped");
});

test("comments: a v6 stored list loads; malformed entries are dropped; a non-list is empty", () => {
  const ok = { id: "c1", folder: "api", path: "a.ts", start: 3, end: 4, text: "why", created: 1700000000000 };
  const stored = JSON.stringify([ok]);
  assert.deepEqual(commentsCodec.parse(stored), [ok]);
  assert.equal(commentsCodec.stringify([ok]), stored, "byte-identical round trip");
  const mixed = JSON.stringify([
    ok,
    { ...ok, id: "c2", start: 0 },
    { ...ok, id: "c3", end: 2 },
    { ...ok, id: "c4", text: "  " },
    { ...ok, id: "c5", path: "" },
    null,
    7,
    "x",
  ]);
  assert.deepEqual(commentsCodec.parse(mixed), [ok]);
  for (const bad of [null, "", "{", "{}", "null", '"x"']) assert.deepEqual(commentsCodec.parse(bad), [], String(bad));
  assert.equal(isCodeComment({ ...ok, start: 1.5 }), false);
  assert.equal(isCodeComment({ ...ok, created: "now" }), false);
});
