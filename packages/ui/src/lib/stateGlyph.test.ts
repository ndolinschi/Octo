import assert from "node:assert/strict";
import test from "node:test";
import { agentGlyph, arcPath, dashArray, glyphGeometry, glyphLabel, orchestratorGlyph, ringRadius, type GlyphState } from "./stateGlyph";

const ALL: GlyphState[] = ["working", "queued", "needs", "unseen", "idle", "failed"];

test("every state is a ring of one diameter (one family), inside its box", () => {
  for (const size of [12, 14] as const) {
    const radii = new Set(ALL.map((s) => glyphGeometry(s, size).r));
    assert.equal(radii.size, 1, `size ${size}: one radius`);
    const r = ringRadius(size);
    assert.ok(size / 2 - r >= 0.75 + 0.5 - 1e-9, "stroke + half a pixel fits");
  }
});

test("each state differs by line style or mark, not only by colour", () => {
  const sig = ALL.map((s) => {
    const g = glyphGeometry(s);
    return JSON.stringify([g.dash !== null, g.arc !== null, g.dot, g.bar !== null, g.alert !== null]);
  });
  assert.equal(new Set(sig).size, ALL.length - 0, "six distinct shapes");
});

test("queued has six dashes summing to the circumference", () => {
  const r = 5;
  const [dash, gap] = dashArray(r).split(" ").map(Number);
  assert.ok(dash !== undefined && gap !== undefined);
  assert.ok(Math.abs((dash + gap) * 6 - 2 * Math.PI * r) < 0.01);
  assert.ok(dash > gap);
});

test("the working arc is a quarter from 12 o'clock to 3 o'clock", () => {
  assert.equal(arcPath(6, 4.75), "M6 1.25A4.75 4.75 0 0 1 10.75 6");
  assert.equal(glyphGeometry("working").ringOpacity, 0.4);
  assert.equal(glyphGeometry("idle").ringOpacity, 1);
  assert.equal(glyphGeometry("idle").stroke, 1, "idle is the thin ring");
  assert.equal(glyphGeometry("working").stroke, 1.5);
});

test("needs is an exclamation mark, unseen a disc (shape, not colour); failed has a bar inside the ring", () => {
  const needs = glyphGeometry("needs", 14);
  const unseen = glyphGeometry("unseen", 14);
  assert.equal(needs.dot, null, "no disc for needs you");
  assert.ok(needs.alert && needs.alert.y1 < needs.alert.y2 && needs.alert.y2 < needs.alert.cy, "an upright stroke above a dot");
  assert.ok(needs.alert.cy + needs.alert.dr < needs.c + needs.r - 0.75, "inside the ring");
  assert.ok(unseen.dot !== null && unseen.alert === null);
  const bar = glyphGeometry("failed", 14).bar;
  assert.ok(bar);
  const len = Math.hypot(bar.x2 - bar.x1, bar.y2 - bar.y1) / 2;
  assert.ok(len < ringRadius(14), "the bar stays inside the ring");
});

test("state mapping from agents and orchestrators", () => {
  assert.equal(agentGlyph("running"), "working");
  assert.equal(agentGlyph("failed"), "failed");
  assert.equal(agentGlyph("completed"), "idle");
  assert.equal(agentGlyph("completed", true), "unseen");
  assert.equal(orchestratorGlyph("new"), "queued");
  assert.equal(orchestratorGlyph("idle", true), "unseen");
  assert.equal(orchestratorGlyph("working", true), "working", "working wins over unseen");
  assert.equal(orchestratorGlyph("needs"), "needs");
  assert.equal(glyphLabel("queued"), "Not started");
});
