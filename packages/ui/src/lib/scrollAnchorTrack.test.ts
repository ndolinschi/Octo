import assert from "node:assert/strict";
import test from "node:test";
import { pickAnchor } from "./scrollAnchorTrack";

/** A laid-out item: its box, its parent item, and whether it is rendered. */
type Item = { id: string; top: number; bottom: number; parent: Item | null; empty?: boolean };

const box = (i: Item) => ({ top: i.top, bottom: i.bottom, empty: !!i.empty });
const contains = (a: Item, b: Item) => {
  for (let p: Item | null = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
};
const pick = (items: Item[], edge: number) => pickAnchor(items, box, edge, contains, (i) => i.parent)?.id ?? null;

/** The rule before the bisection: every candidate measured, the first 40 below the edge, the first containing no other. */
function exhaustive(items: Item[], edge: number): string | null {
  const near = items.filter((e) => !e.empty && e.bottom > edge + 1).slice(0, 40);
  return near.find((c) => !near.some((o) => o !== c && contains(c, o)))?.id ?? null;
}

/** `n` answers (articles) of `p` paragraphs each, 20px tall with 10px between paragraphs and 30px between answers. */
function transcript(n: number, p: number): Item[] {
  const out: Item[] = [];
  let y = 0;
  for (let a = 0; a < n; a++) {
    const article: Item = { id: `a${a}`, top: y, bottom: 0, parent: null };
    out.push(article);
    for (let k = 0; k < p; k++) {
      out.push({ id: `a${a}p${k}`, top: y, bottom: y + 20, parent: article });
      y += 30;
    }
    article.bottom = y - 10;
    y += 30;
  }
  return out;
}

test("pickAnchor: the paragraph at the top edge, as measuring every candidate found it", () => {
  const items = transcript(30, 6);
  for (let edge = -50; edge < 6000; edge += 7) assert.equal(pick(items, edge), exhaustive(items, edge), `edge ${edge}`);
});

test("pickAnchor: an edge between paragraphs or between answers picks the next paragraph", () => {
  const items = transcript(3, 3);
  assert.equal(pick(items, 22), "a0p1");
  assert.equal(pick(items, 85), "a1p0");
});

test("pickAnchor: an answer without paragraphs is its own anchor; nothing below the edge is null", () => {
  const items: Item[] = [
    { id: "a0", top: 0, bottom: 100, parent: null },
    { id: "a1", top: 120, bottom: 200, parent: null },
  ];
  assert.equal(pick(items, 50), "a0");
  assert.equal(pick(items, 110), "a1");
  assert.equal(pick(items, 500), null);
});

test("pickAnchor: items that are not rendered (an empty box at 0) are stepped over", () => {
  const items = transcript(10, 4);
  for (const i of items) if (i.id.endsWith("p2")) Object.assign(i, { top: 0, bottom: 0, empty: true });
  for (let edge = 0; edge < 1500; edge += 5) assert.equal(pick(items, edge), exhaustive(items, edge), `edge ${edge}`);
});

test("pickAnchor: no candidates", () => {
  assert.equal(pick([], 10), null);
});
