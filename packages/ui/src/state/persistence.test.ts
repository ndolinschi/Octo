import assert from "node:assert/strict";
import test from "node:test";
import { fileKey } from "../lib/files";
import { PREFS, loadPref } from "../lib/storage";
import { themeCodec } from "./themePref";
import { TREE_DEFAULT, TREE_MAX, treePrefCodec } from "./fileViewPrefs";
import { CHAT, allTabs, fileTab, initialLayout, layoutCodec, serialize, toolTab } from "./workspace/layout";

/** Stored preferences of the state layer: text written since v6 loads, and writes stay byte-compatible. */

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } },
    configurable: true,
    writable: true,
  });
}

test("theme: values stored since v6 load; anything else is system", () => {
  assert.equal(themeCodec.parse("dark"), "dark");
  assert.equal(themeCodec.parse("light"), "light");
  assert.equal(themeCodec.parse("system"), "system");
  assert.equal(themeCodec.parse(null), "system");
  assert.equal(themeCodec.parse("solarized"), "system");
  assert.equal(themeCodec.stringify("light"), "light", "plain text, not JSON");
});

test("file tree preference: v6 text loads, byte-compatible on write", () => {
  assert.deepEqual(treePrefCodec.parse('{"open":false,"width":320}'), { open: false, width: 320 });
  assert.equal(treePrefCodec.stringify({ open: false, width: 320 }), '{"open":false,"width":320}');
  assert.deepEqual(treePrefCodec.parse(null), { open: true, width: TREE_DEFAULT });
  assert.equal(treePrefCodec.parse('{"width":9999}').width, TREE_MAX);
});

test("layout: text written by v6 loads; nothing usable gives Chat alone", () => {
  const v6 = JSON.stringify({
    v: 1,
    groups: [
      { tabs: ["chat", "files"], active: "chat", size: 0.6 },
      { tabs: ["agent:a1", `file:${fileKey("web", "src/a.ts")}`], active: "agent:a1", size: 0.4 },
    ],
    focused: 1,
  });
  const l = layoutCodec.parse(v6);
  assert.equal(l.groups.length, 2);
  assert.deepEqual(allTabs(l), [CHAT, toolTab("files"), "agent:a1", fileTab(fileKey("web", "src/a.ts"))]);
  assert.equal(l.focused, l.groups[1]?.id);
  assert.deepEqual(JSON.parse(layoutCodec.stringify(l)), JSON.parse(v6), "same JSON back");
  for (const bad of [null, "", "{", '{"v":2}']) assert.deepEqual(allTabs(layoutCodec.parse(bad)), [CHAT], String(bad));
  const fresh = initialLayout();
  assert.equal(layoutCodec.stringify(fresh), serialize(fresh));
});

test("loadPref validates what storage holds", () => {
  fakeStorage({ "octo.theme": "light", "octo.layout.p": "garbage" });
  assert.equal(loadPref(PREFS.theme, themeCodec), "light");
  assert.deepEqual(allTabs(loadPref(PREFS.layout("p"), layoutCodec)), [CHAT]);
  assert.equal(loadPref(PREFS.layout("other"), { parse: (raw) => raw ?? "none", stringify: String }), "none");
});
