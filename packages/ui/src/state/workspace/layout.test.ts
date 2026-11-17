import { fileKey } from "../../lib/files";
import { must } from "../../lib/must";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT,
  firstLayout,
  SIDE_FIRST_WIDTH,
  MAX_GROUPS,
  activate,
  agentTab,
  allTabs,
  browserTab,
  canSplit,
  close,
  closable,
  deserialize,
  ensureSize,
  equalize,
  fileTab,
  focusGroup,
  focusedGroup,
  groupOf,
  initialLayout,
  move,
  moveToOtherSide,
  open,
  otherSide,
  parseTab,
  parseTabId,
  prune,
  replace,
  resize,
  serialize,
  shownTool,
  besideChat,
  sideGroup,
  split,
  type Group,
  type Layout,
  toolTab,
  type TabId,
} from "./layout";

const FILES = toolTab("files");
const BROWSER = toolTab("browser");
const PROCESSES = toolTab("processes");
const NOTES = toolTab("notes");
const AGENTS = toolTab("agents");
const DETAILS = toolTab("details");
const f = (name: string) => fileTab(fileKey("proj", name));
const group = (id: string, tabs: TabId[], size: number, active = tabs[0] ?? CHAT): Group => ({ id, tabs, active, size });
const layoutOf = (groups: Group[], focused = groups[0]?.id ?? ""): Layout => ({ groups, focused });

/** Every promise `normalize` makes, checked after any operation. */
function check(layout: Layout, label: string) {
  const tabs = allTabs(layout);
  assert.ok(layout.groups.length >= 1 && layout.groups.length <= MAX_GROUPS, `${label}: 1..${MAX_GROUPS} groups, got ${layout.groups.length}`);
  assert.equal(tabs.filter((t) => t === CHAT).length, 1, `${label}: Chat exactly once`);
  assert.equal(new Set(tabs).size, tabs.length, `${label}: no duplicate tab`);
  for (const g of layout.groups) {
    assert.ok(g.tabs.length > 0, `${label}: no empty group`);
    assert.ok(g.tabs.includes(g.active), `${label}: active tab belongs to its group`);
    assert.ok(Number.isFinite(g.size) && g.size > 0, `${label}: positive size`);
  }
  const sum = layout.groups.reduce((n, g) => n + g.size, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `${label}: sizes sum to 1, got ${sum}`);
  assert.ok(
    layout.groups.some((g) => g.id === layout.focused),
    `${label}: focused group exists`,
  );
}

/** mulberry32: a small seeded PRNG so a failing sequence can be replayed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("tab ids: constructors and parseTabId round trip; foreign strings are rejected", () => {
  const all = [CHAT, FILES, BROWSER, PROCESSES, NOTES, AGENTS, DETAILS, agentTab("a1"), browserTab("b1"), f("src/a.ts"), f("")];
  for (const id of all) assert.equal(parseTabId(id), id, id);
  assert.equal(parseTabId(agentTab("x")), "agent:x");
  assert.equal(parseTabId(browserTab("b1")), "browser:b1");
  for (const foreign of ["", "chat ", "Chat", "tools", "agent:", "browser:", "agent", "file:", "file:nosep", "file:a/b", "x", "files:", "details2"]) {
    assert.equal(parseTabId(foreign), null, JSON.stringify(foreign));
  }
  assert.equal(parseTabId(null), null);
  assert.equal(parseTabId(undefined), null);
  assert.deepEqual(parseTab(f("a.ts")), { kind: "file", key: fileKey("proj", "a.ts") });
});

test("tab ids: parse, build and the Chat rule", () => {
  assert.deepEqual(parseTab(CHAT), { kind: "chat" });
  assert.deepEqual(parseTab("files"), { kind: "tool", tool: "files" });
  assert.deepEqual(parseTab("browser"), { kind: "tool", tool: "browser" });
  assert.deepEqual(parseTab(browserTab("b1")), { kind: "browser", browserId: "b1" });
  assert.deepEqual(parseTab(agentTab("a1")), { kind: "agent", agentId: "a1" });
  assert.deepEqual(parseTab(f("src/a.ts")), { kind: "file", key: fileKey("proj", "src/a.ts") });
  for (const bad of ["", "agent:", "browser:", "file:no-nul", "tools", "Chat", "agent"]) assert.equal(parseTab(bad), null, bad);
  assert.equal(closable(CHAT), false);
  assert.equal(closable(FILES), true);
  assert.equal(closable(BROWSER), true);
  assert.equal(closable(browserTab("b1")), true);
  assert.equal(shownTool(layoutOf([group("a", [CHAT], 0.5), group("b", [browserTab("b1")], 0.5)], "b")), "browser");
});

test("a fresh layout is one Chat group", () => {
  const l = initialLayout();
  check(l, "initial");
  assert.deepEqual(allTabs(l), [CHAT]);
  assert.equal(focusedGroup(l).id, l.focused);
});

test("open adds a tab after the active one and focuses it; an open tab is only focused", () => {
  let l = initialLayout();
  const g = must(l.groups[0]).id;
  l = open(l, FILES, { group: g });
  l = open(l, NOTES, { group: g });
  assert.deepEqual(must(l.groups[0]).tabs, [CHAT, FILES, NOTES]);
  assert.equal(must(l.groups[0]).active, NOTES);
  l = activate(l, CHAT);
  l = open(l, AGENTS, { group: g });
  assert.deepEqual(must(l.groups[0]).tabs, [CHAT, AGENTS, FILES, NOTES], "inserted right after the active tab");
  const again = open(l, FILES, { newAfter: g, size: 0.5 });
  assert.equal(again.groups.length, 1, "already open: no new group");
  assert.equal(must(again.groups[0]).active, FILES);
  check(again, "reopen");
});

test("open at an unknown group falls back to the focused one", () => {
  const l = open(initialLayout(), FILES, { group: "nope" });
  assert.deepEqual(must(l.groups[0]).tabs, [CHAT, FILES]);
});

test("open into a new group takes the asked share, capped at 80% of the anchor", () => {
  const l0 = initialLayout();
  const l1 = open(l0, FILES, { newAfter: must(l0.groups[0]).id, size: 0.4 });
  assert.equal(l1.groups.length, 2);
  assert.deepEqual(must(l1.groups[1]).tabs, [FILES]);
  assert.ok(Math.abs(must(l1.groups[1]).size - 0.4) < 1e-9);
  assert.equal(l1.focused, must(l1.groups[1]).id);
  const l2 = open(l0, FILES, { newAfter: must(l0.groups[0]).id, size: 5 });
  assert.ok(Math.abs(must(l2.groups[1]).size - 0.8) < 1e-9);
  check(l2, "capped");
});

test("the group cap: a fifth group is refused and nothing changes", () => {
  let l = initialLayout();
  const tools = [FILES, NOTES, AGENTS, DETAILS];
  for (const t of tools.slice(0, 3)) l = open(l, t, { newAfter: must(l.groups[l.groups.length - 1]).id, size: 0.2 });
  assert.equal(l.groups.length, MAX_GROUPS);
  const refused = open(l, DETAILS, { newAfter: must(l.groups[0]).id, size: 0.2 });
  assert.equal(refused, l);
});

test("canSplit: a lone tab cannot split from its own group; leaving a group empty frees a slot", () => {
  const a = group("a", [CHAT], 0.5);
  const b = group("b", [FILES], 0.5);
  const l = layoutOf([a, b]);
  assert.equal(canSplit(l, CHAT, "a"), false);
  assert.equal(canSplit(l, FILES, "a"), true);
  assert.equal(canSplit(l, agentTab("missing"), "a"), false);
  const full = layoutOf([group("a", [CHAT, agentTab("x1")], 0.25), group("b", [FILES], 0.25), group("c", [NOTES], 0.25), group("d", [AGENTS], 0.25)]);
  assert.equal(canSplit(full, agentTab("x1"), "a"), false, "4 groups, source keeps its group: over the cap");
  assert.equal(canSplit(full, FILES, "a"), true, "source group disappears: still 4");
});

test("close: Chat never closes, neighbour on the right becomes active, emptied groups vanish", () => {
  let l = layoutOf([group("a", [CHAT, FILES, NOTES, DETAILS], 0.6, NOTES), group("b", [AGENTS], 0.4)], "a");
  assert.equal(must(close(l, [CHAT]).groups[0]).tabs.includes(CHAT), true);
  l = close(l, [NOTES]);
  assert.equal(must(l.groups[0]).active, DETAILS, "right neighbour");
  l = close(l, [DETAILS]);
  assert.equal(must(l.groups[0]).active, FILES, "falls back to the left neighbour");
  l = close(l, [AGENTS]);
  assert.equal(l.groups.length, 1);
  assert.ok(Math.abs(must(l.groups[0]).size - 1) < 1e-9, "its width goes to the neighbour");
  check(l, "closed");
});

test("closing the focused group's last tab moves focus to its left neighbour", () => {
  const l = layoutOf([group("a", [CHAT], 0.3), group("b", [FILES], 0.3), group("c", [NOTES], 0.4)], "b");
  const next = close(l, [FILES]);
  assert.equal(next.focused, "a");
  assert.deepEqual(
    next.groups.map((g) => g.id),
    ["a", "c"],
  );
  assert.ok(Math.abs(must(next.groups[0]).size - 0.6) < 1e-9, "the emptied width goes left");
  const first = layoutOf([group("a", [FILES], 0.5), group("b", [CHAT], 0.5)], "a");
  assert.equal(close(first, [FILES]).focused, "b");
});

test("closing an unknown tab changes nothing but stays valid", () => {
  const l = initialLayout();
  check(close(l, [agentTab("ghost")]), "ghost");
  assert.deepEqual(allTabs(close(l, [agentTab("ghost")])), [CHAT]);
});

test("move: across groups (default after active, or at an index), within a group, to a missing group", () => {
  const l = layoutOf([group("a", [CHAT, FILES, NOTES], 0.5, FILES), group("b", [AGENTS, DETAILS], 0.5)], "a");
  const m = move(l, NOTES, "b", 0);
  assert.deepEqual(must(m.groups[1]).tabs, [NOTES, AGENTS, DETAILS]);
  assert.equal(m.focused, "b");
  const after = move(l, NOTES, "b");
  assert.deepEqual(must(after.groups[1]).tabs, [AGENTS, NOTES, DETAILS]);
  const within = move(l, CHAT, "a", 3);
  assert.deepEqual(must(within.groups[0]).tabs, [CHAT, FILES, NOTES], "the Orchestrator tab stays pinned first");
  assert.deepEqual(must(move(l, NOTES, "a", 0).groups[0]).tabs, [CHAT, NOTES, FILES], "nothing goes before the pinned tab");
  const inPlace = move(l, NOTES, "a", 3);
  assert.deepEqual(must(inPlace.groups[0]).tabs, [CHAT, FILES, NOTES]);
  assert.equal(move(l, NOTES, "zzz"), l);
  assert.equal(move(l, agentTab("ghost"), "a"), l);
  check(m, "move");
});

test("moving the only tab out of a group removes the group", () => {
  const l = layoutOf([group("a", [CHAT, FILES], 0.5), group("b", [NOTES], 0.5)], "a");
  const m = move(l, NOTES, "a");
  assert.equal(m.groups.length, 1);
  assert.deepEqual(must(m.groups[0]).tabs, [CHAT, NOTES, FILES]);
  check(m, "emptied source");
});

test("split puts the tab in a new group on the chosen side of the target", () => {
  const l = layoutOf([group("a", [CHAT, FILES], 1)], "a");
  const right = split(l, FILES, "a", "right");
  assert.deepEqual(
    right.groups.map((g) => g.tabs),
    [[CHAT], [FILES]],
  );
  assert.ok(Math.abs(must(right.groups[0]).size - 0.5) < 1e-9, "default: half of the anchor");
  const left = split(l, FILES, "a", "left", 0.3);
  assert.deepEqual(
    left.groups.map((g) => g.tabs),
    [[FILES], [CHAT]],
  );
  assert.ok(Math.abs(must(left.groups[0]).size - 0.3) < 1e-9);
  assert.equal(left.focused, must(left.groups[0]).id);
  assert.equal(split(layoutOf([group("a", [CHAT], 1)]), CHAT, "a", "right").groups.length, 1, "a lone tab does not split from itself");
  check(right, "split right");
  check(left, "split left");
});

test("otherSide and moveToOtherSide", () => {
  const solo = layoutOf([group("a", [CHAT, FILES], 1)]);
  assert.deepEqual(otherSide(solo, "a"), { newAfter: "a", size: 0.5 });
  assert.equal(otherSide(solo, "nope"), null);
  const two = layoutOf([group("a", [CHAT, FILES], 0.5), group("b", [NOTES], 0.5)]);
  assert.deepEqual(otherSide(two, "a"), { group: "b" });
  assert.deepEqual(otherSide(two, "b"), { group: "a" }, "the last group's other side is the previous one");
  const moved = moveToOtherSide(solo, FILES);
  assert.deepEqual(
    moved.groups.map((g) => g.tabs),
    [[CHAT], [FILES]],
  );
  assert.equal(moveToOtherSide(layoutOf([group("a", [CHAT], 1)]), CHAT).groups.length, 1, "a lone tab stays");
  assert.deepEqual(must(moveToOtherSide(two, NOTES).groups[0]).tabs, [CHAT, NOTES, FILES], "lands after the active tab");
  assert.equal(moveToOtherSide(two, agentTab("ghost")), two);
});

test("sideGroup: beside Chat, right first", () => {
  assert.equal(sideGroup(initialLayout()), null);
  const l = layoutOf([group("a", [FILES], 0.3), group("b", [CHAT], 0.4), group("c", [NOTES], 0.3)]);
  assert.equal(sideGroup(l)?.id, "c");
  assert.equal(sideGroup(layoutOf([group("a", [FILES], 0.5), group("b", [CHAT], 0.5)]))?.id, "a");
});

test("activate and focusGroup ignore what does not exist and keep identity when nothing changes", () => {
  const l = layoutOf([group("a", [CHAT, FILES], 0.5, CHAT), group("b", [NOTES], 0.5)], "a");
  assert.equal(activate(l, CHAT), l);
  assert.equal(activate(l, agentTab("ghost")), l);
  assert.equal(activate(l, NOTES).focused, "b");
  assert.equal(focusGroup(l, "a"), l);
  assert.equal(focusGroup(l, "ghost"), l);
  assert.equal(focusGroup(l, "b").focused, "b");
});

test("replace swaps a tab in place; Chat is never replaced; an open target just closes the old", () => {
  const l = layoutOf([group("a", [CHAT, FILES, NOTES], 0.5, FILES), group("b", [DETAILS], 0.5)], "a");
  const r = replace(l, FILES, f("x.ts"));
  assert.deepEqual(must(r.groups[0]).tabs, [CHAT, f("x.ts"), NOTES]);
  assert.equal(must(r.groups[0]).active, f("x.ts"));
  const toOpen = replace(l, FILES, DETAILS);
  assert.deepEqual(allTabs(toOpen), [CHAT, NOTES, DETAILS]);
  assert.equal(must(toOpen.groups[1]).active, DETAILS);
  const chat = replace(l, CHAT, AGENTS);
  assert.ok(must(chat.groups[0]).tabs.includes(CHAT));
  assert.ok(allTabs(chat).includes(AGENTS));
  check(r, "replace");
  check(toOpen, "replace open");
  check(chat, "replace chat");
});

test("resize moves one divider, keeps the pair's total and both sides at least min", () => {
  const l = layoutOf([group("a", [CHAT], 0.5), group("b", [FILES], 0.3), group("c", [NOTES], 0.2)]);
  const r = resize(l, 0, 0.1, 0.1);
  assert.ok(Math.abs(must(r.groups[0]).size - 0.6) < 1e-9);
  assert.ok(Math.abs(must(r.groups[1]).size - 0.2) < 1e-9);
  assert.equal(must(r.groups[2]).size, 0.2, "other groups untouched");
  const clampedRight = resize(l, 0, 5, 0.1);
  assert.ok(Math.abs(must(clampedRight.groups[1]).size - 0.1) < 1e-9);
  const clampedLeft = resize(l, 0, -5, 0.1);
  assert.ok(Math.abs(must(clampedLeft.groups[0]).size - 0.1) < 1e-9);
  assert.equal(resize(l, 2, 0.1, 0.1), l, "no divider after the last group");
  assert.equal(resize(l, -1, 0.1, 0.1), l);
  check(r, "resize");
});

test("resize keeps each side at its own floor (decision 67: the conversation 420, the editor 360)", () => {
  const l = layoutOf([group("a", [CHAT], 0.5), group("b", [FILES], 0.5)]);
  const left = resize(l, 0, -5, 0.4, 0.3);
  assert.ok(Math.abs(must(left.groups[0]).size - 0.4) < 1e-9);
  const right = resize(l, 0, 5, 0.4, 0.3);
  assert.ok(Math.abs(must(right.groups[1]).size - 0.3) < 1e-9);
  const tight = layoutOf([group("a", [CHAT], 0.3), group("b", [FILES], 0.3)]);
  const t = resize(tight, 0, 0.2, 0.4, 0.2);
  assert.ok(Math.abs(must(t.groups[0]).size + must(t.groups[1]).size - 0.6) < 1e-9, "a pair under its floors keeps its total");
  assert.ok(must(t.groups[0]).size > must(t.groups[1]).size, "split in proportion to the floors");
});

test("resize on a pair narrower than two minimums splits it evenly, never a negative size", () => {
  const l = layoutOf([group("a", [CHAT], 0.04), group("b", [FILES], 0.06), group("c", [NOTES], 0.9)]);
  for (const delta of [-1, -0.01, 0, 0.02, 1]) {
    const r = resize(l, 0, delta, 0.1);
    const [a, b] = [must(r.groups[0]).size, must(r.groups[1]).size];
    assert.ok(a > 0 && b > 0, `delta ${delta}: both sides positive (${a}, ${b})`);
    assert.ok(Math.abs(a + b - 0.1) < 1e-9, "the pair keeps its total");
    assert.ok(Math.abs(a - 0.05) < 1e-9, "an impossible minimum degrades to an even split");
    check(r, `narrow pair, delta ${delta}`);
  }
});

test("ensureSize grows a group at the others' expense, proportionally", () => {
  const l = layoutOf([group("a", [CHAT], 0.6), group("b", [FILES], 0.3), group("c", [NOTES], 0.1)]);
  const e = ensureSize(l, "c", 0.4);
  assert.ok(Math.abs(must(e.groups[2]).size - 0.4) < 1e-9);
  assert.ok(Math.abs(must(e.groups[0]).size / must(e.groups[1]).size - 2) < 1e-9, "the others keep their ratio");
  check(e, "ensure");
  assert.equal(ensureSize(l, "a", 0.4), l, "already big enough");
  const solo = layoutOf([group("a", [CHAT], 1)]);
  assert.equal(ensureSize(solo, "a", 2), solo, "a lone group has nobody to take from");
  assert.equal(ensureSize(l, "ghost", 0.4), l);
});

test("equalize gives every group the same share", () => {
  const l = equalize(layoutOf([group("a", [CHAT], 0.7), group("b", [FILES], 0.2), group("c", [NOTES], 0.1)]));
  for (const g of l.groups) assert.ok(Math.abs(g.size - 1 / 3) < 1e-9);
  check(l, "equalize");
});

test("prune closes stale tabs only, never Chat, and returns the same layout when nothing is stale", () => {
  const l = layoutOf([group("a", [CHAT, agentTab("gone"), agentTab("kept")], 0.5), group("b", [f("x")], 0.5)]);
  assert.equal(
    prune(l, () => true),
    l,
  );
  const p = prune(l, (t) => t === agentTab("kept"));
  assert.deepEqual(allTabs(p), [CHAT, agentTab("kept")]);
  assert.equal(prune(l, () => false).groups.length, 1);
  check(p, "prune");
});

test("serialize / deserialize round trip keeps tabs, active, focus and (rounded) sizes", () => {
  const l = layoutOf([group("a", [CHAT, FILES], 0.3333333, FILES), group("b", [agentTab("x"), f("y.ts")], 0.6666667, f("y.ts"))], "b");
  const back = deserialize(serialize(l));
  assert.ok(back);
  check(back, "round trip");
  assert.deepEqual(
    back.groups.map((g) => [g.tabs, g.active]),
    [
      [[CHAT, FILES], FILES],
      [[agentTab("x"), f("y.ts")], f("y.ts")],
    ],
  );
  assert.equal(back.focused, must(back.groups[1]).id);
  assert.ok(Math.abs(must(back.groups[0]).size - 1 / 3) < 1e-3);
});

test("deserialize rejects malformed input", () => {
  for (const raw of [null, "", "not json", "{}", "[]", "null", '{"v":2,"groups":[]}', '{"v":1}', '{"v":1,"groups":"x"}'])
    assert.equal(deserialize(raw), null, String(raw));
});

test("deserialize drops unknown and duplicate tabs, caps groups, and puts Chat back", () => {
  const raw = JSON.stringify({
    v: 1,
    groups: [
      { tabs: ["files", "bogus", 7, null, "agent:"], active: "bogus", size: 0.2 },
      { tabs: ["files", "notes"], active: "notes", size: 0.2 },
      "junk",
      { tabs: ["details"], active: "details", size: 0.2 },
      { tabs: ["agents"], active: "agents", size: 0.2 },
      { tabs: [f("beyond-the-cap")], active: "", size: 0.2 },
    ],
    focused: 99,
  });
  const l = deserialize(raw);
  assert.ok(l);
  check(l, "deserialized");
  assert.equal(allTabs(l).filter((t) => t === FILES).length, 1, "duplicate dropped");
  assert.ok(!allTabs(l).some((t) => t === "bogus"));
  assert.ok(!allTabs(l).includes(f("beyond-the-cap")), "only the first four groups are read");
  assert.deepEqual(must(l.groups[0]).tabs.slice(0, 2), [CHAT, FILES], "Chat is restored at the head of the first group");
  assert.equal(must(l.groups[0]).active, FILES, "a stale active falls back to the first stored tab");
});

test("deserialize drops a tab repeated inside one group; the first occurrence wins", () => {
  const l = deserialize(JSON.stringify({ v: 1, groups: [{ tabs: [CHAT, "files", "notes", "files"], active: CHAT, size: 1 }], focused: 0 }));
  assert.ok(l);
  check(l, "repeat in one group");
  assert.deepEqual(must(l.groups[0]).tabs, [CHAT, FILES, NOTES], "order of first occurrences kept");
  const across = deserialize(
    JSON.stringify({
      v: 1,
      groups: [
        { tabs: ["files", "files"], active: "files", size: 0.5 },
        { tabs: ["files", "notes", "notes"], active: "notes", size: 0.5 },
      ],
      focused: 1,
    }),
  );
  assert.ok(across);
  check(across, "repeat across and within groups");
  assert.deepEqual(
    across.groups.map((g) => g.tabs),
    [[CHAT, FILES], [NOTES]],
  );
});

test("splitting Chat out of a group that has other tabs leaves Chat exactly once", () => {
  const l = layoutOf([group("a", [CHAT, FILES], 1)]);
  for (const side of ["left", "right"] as const) {
    const out = split(l, CHAT, "a", side);
    check(out, `split chat ${side}`);
    assert.deepEqual(
      out.groups.map((g) => g.tabs),
      side === "right" ? [[FILES], [CHAT]] : [[CHAT], [FILES]],
      "Chat moved into the new group, the rest stayed",
    );
    assert.equal(focusedGroup(out).active, CHAT);
  }
  const two = layoutOf([group("a", [CHAT, FILES], 0.5), group("b", [NOTES], 0.5)]);
  check(split(two, CHAT, "b", "right"), "split chat beside another group");
  check(split(two, CHAT, "a", "left"), "split chat beside its own group");
});

test("moving Chat to the other side keeps it in exactly one group", () => {
  const solo = layoutOf([group("a", [CHAT, FILES, NOTES], 1)]);
  const moved = moveToOtherSide(solo, CHAT);
  check(moved, "solo");
  assert.equal(moved.groups.length, 2);
  const two = layoutOf([group("a", [CHAT, FILES], 0.5), group("b", [NOTES], 0.5)]);
  check(moveToOtherSide(two, CHAT), "two groups");
  check(move(two, CHAT, "b", 0), "move into another group");
});

test("deserialize: a stored Chat twice keeps one; a layout without any tab becomes Chat alone", () => {
  const twice = deserialize(
    JSON.stringify({
      v: 1,
      groups: [
        { tabs: [CHAT], active: CHAT, size: 0.5 },
        { tabs: [CHAT, FILES], active: CHAT, size: 0.5 },
      ],
      focused: 1,
    }),
  );
  assert.ok(twice);
  check(twice, "chat twice");
  const empty = deserialize(JSON.stringify({ v: 1, groups: [{ tabs: [], active: "", size: 1 }], focused: 0 }));
  assert.ok(empty);
  check(empty, "empty");
  assert.deepEqual(allTabs(empty), [CHAT]);
});

test("normalising a stored layout is idempotent: serialize(deserialize(x)) is stable", () => {
  const raw = JSON.stringify({
    v: 1,
    groups: [
      { tabs: ["files", "files", "x"], active: "q", size: 0.9 },
      { tabs: [], active: "", size: 0.3 },
      { tabs: [agentTab("a")], active: agentTab("a"), size: 0.1 },
    ],
    focused: 2,
  });
  const once = deserialize(raw);
  assert.ok(once);
  const twice = deserialize(serialize(once));
  assert.ok(twice);
  const shape = (l: Layout) => l.groups.map((g) => ({ tabs: g.tabs, active: g.active, size: Math.round(g.size * 1e4) / 1e4 }));
  assert.deepEqual(shape(twice), shape(once));
  assert.equal(groupOf(twice, agentTab("a"))?.id, must(twice.groups[twice.groups.length - 1]).id);
});

test("an emptied stored group hands its width to the neighbour on its left", () => {
  const l = deserialize(
    JSON.stringify({
      v: 1,
      groups: [
        { tabs: [CHAT], active: CHAT, size: 0.5 },
        { tabs: ["bogus"], active: "bogus", size: 0.25 },
        { tabs: ["files"], active: "files", size: 0.25 },
      ],
      focused: 0,
    }),
  );
  assert.ok(l);
  assert.equal(l.groups.length, 2);
  assert.ok(Math.abs(must(l.groups[0]).size - 0.75) < 1e-9);
});

test("stored sizes that are partly invalid still normalise to a whole row (all groups are equalised)", () => {
  for (const bad of ["wide", 0, -1, null, 2, Number.NaN]) {
    const l = deserialize(
      JSON.stringify({
        v: 1,
        groups: [
          { tabs: [CHAT], active: CHAT, size: 0.5 },
          { tabs: ["files"], active: "files", size: bad },
          { tabs: ["notes"], active: "notes", size: 0.25 },
        ],
        focused: 0,
      }),
    );
    assert.ok(l);
    check(l, `invalid size ${String(bad)}`);
    for (const g of l.groups) assert.ok(Math.abs(g.size - 1 / 3) < 1e-9, `equal share, got ${g.size}`);
  }
});

test("all-valid sizes are scaled to sum to 1, keeping their proportions", () => {
  const l = deserialize(
    JSON.stringify({
      v: 1,
      groups: [
        { tabs: [CHAT], active: CHAT, size: 0.3 },
        { tabs: ["files"], active: "files", size: 0.1 },
      ],
      focused: 0,
    }),
  );
  assert.ok(l);
  check(l, "scaled");
  assert.ok(Math.abs(must(l.groups[0]).size - 0.75) < 1e-9);
});

test("randomised operation sequences keep every invariant (seeded)", () => {
  const pool: TabId[] = [CHAT, AGENTS, NOTES, FILES, DETAILS, agentTab("a"), agentTab("b"), agentTab("c"), f("1"), f("2"), f("3"), f("4")];
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = prng(seed);
    const pick = <T>(xs: T[]): T => must(xs[Math.floor(rnd() * xs.length)]);
    let l = initialLayout();
    const log: string[] = [];
    for (let step = 0; step < 80; step++) {
      const tab = pick(pool);
      const g = pick(l.groups).id;
      const op = Math.floor(rnd() * 13);
      log.push(`${op}:${tab}`);
      switch (op) {
        case 0:
          l = open(l, tab, { group: g });
          break;
        case 1:
          l = open(l, tab, { newAfter: g, size: 0.1 + rnd() * 0.8 });
          break;
        case 2:
          l = close(l, [tab, pick(pool)]);
          break;
        case 3:
          l = move(l, tab, g, rnd() < 0.5 ? undefined : Math.floor(rnd() * 6) - 1);
          break;
        case 4:
          l = split(l, tab, g, rnd() < 0.5 ? "left" : "right", rnd() < 0.5 ? undefined : rnd());
          break;
        case 5:
          l = moveToOtherSide(l, tab);
          break;
        case 6:
          l = activate(l, tab);
          break;
        case 7:
          l = focusGroup(l, g);
          break;
        case 8: {
          const i = Math.floor(rnd() * l.groups.length);
          const a = l.groups[i];
          const b = l.groups[i + 1];
          if (a && b && a.size + b.size >= 0.04) l = resize(l, i, rnd() - 0.5, 0.02);
          break;
        }
        case 9:
          l = equalize(l);
          break;
        case 10:
          l = replace(l, tab, pick(pool));
          break;
        case 11:
          l = prune(l, (t) => t.length % 3 !== 0);
          break;
        default: {
          const back = deserialize(serialize(l));
          assert.ok(back, `seed ${seed}: serialize output parses`);
          assert.deepEqual(
            back.groups.map((x) => x.tabs),
            l.groups.map((x) => x.tabs),
            `seed ${seed}: round trip keeps tabs`,
          );
          l = back;
        }
      }
      check(l, `seed ${seed} step ${step} [${log.slice(-4).join(" ")}]`);
    }
  }
});

test("shownTool: the focused group's tool or file, else the rightmost group's; one at a time", () => {
  const l = layoutOf([group("a", [CHAT, NOTES], 0.5, NOTES), group("b", [DETAILS, f("x.ts")], 0.5, f("x.ts"))], "a");
  assert.equal(shownTool(l), "notes");
  assert.equal(shownTool({ ...l, focused: "b" }), "files");
  assert.equal(shownTool(layoutOf([group("a", [CHAT, NOTES], 0.5), group("b", [DETAILS], 0.5)], "a")), "details");
  assert.equal(shownTool(layoutOf([group("a", [CHAT], 1)])), null);
});

test("besideChat: the group right of the orchestrator's, else a new half-width group to its right", () => {
  assert.deepEqual(besideChat(layoutOf([group("a", [CHAT], 1)])), { newAfter: "a", size: 0.5 });
  assert.deepEqual(besideChat(layoutOf([group("a", [NOTES], 0.3), group("b", [CHAT], 0.4), group("c", [DETAILS], 0.3)])), { group: "c" });
  const full = layoutOf([group("a", [NOTES], 0.25), group("b", [AGENTS], 0.25), group("c", [DETAILS], 0.25), group("d", [CHAT], 0.25)]);
  assert.deepEqual(besideChat(full), { group: "d" }, "at the cap, the last group");
});

test("C3: first open on a wide window with recorded changes → Changes beside the conversation, ~432px, focus stays", () => {
  const base = initialLayout();
  const next = firstLayout({ saved: false, window: 1680, inner: 1392, changedFiles: 8, layout: base });
  assert.ok(next);
  assert.equal(next.groups.length, 2);
  const [chat, side] = next.groups;
  assert.deepEqual(chat?.tabs, [CHAT]);
  assert.deepEqual(side?.tabs, [toolTab("changes")]);
  assert.equal(Math.round((side?.size ?? 0) * 1392), SIDE_FIRST_WIDTH);
  assert.equal(next.focused, chat?.id, "the conversation keeps focus");
});

test("C3: no panel with a saved layout, under 1600px, without changes, or once the layout was changed", () => {
  const base = initialLayout();
  const go = (o: Partial<Parameters<typeof firstLayout>[0]>) => firstLayout({ saved: false, window: 1920, inner: 1632, changedFiles: 3, layout: base, ...o });
  assert.ok(go({}));
  assert.equal(go({ saved: true }), null);
  assert.equal(go({ window: 1599 }), null);
  assert.ok(go({ window: 1600 }));
  assert.equal(go({ changedFiles: 0 }), null, "an empty project opens without a panel");
  assert.equal(go({ inner: 0 }), null, "not measured");
  const touched = open(base, toolTab("files"), { newAfter: base.focused, size: 0.4 });
  assert.equal(go({ layout: touched }), null);
});
