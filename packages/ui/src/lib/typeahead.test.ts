import assert from "node:assert/strict";
import test from "node:test";
import { CLOSED, paletteStep, typeaheadKey, type PaletteEvent, type PaletteGate, type Typeahead } from "./typeahead";

const chars = (s: string): string[] => s.match(/[\s\S]/gu) ?? [];
const type = (keys: string[]): Typeahead => keys.reduce<Typeahead>((held, key) => typeaheadKey(held, key) ?? held, { text: "", enter: false });

test("printable keys are held in order, Backspace removes the last one", () => {
  assert.deepEqual(type(chars("settings")), { text: "settings", enter: false });
  assert.deepEqual(type([...chars("setx"), "Backspace", ...chars("tings")]), { text: "settings", enter: false });
  assert.deepEqual(type(["Backspace"]), { text: "", enter: false });
  assert.deepEqual(type(["🙂", "Backspace"]), { text: "", enter: false });
});

test("Enter is held as the run of the first row; keys after it are swallowed", () => {
  assert.deepEqual(type([...chars("settings"), "Enter", ...chars("xy")]), { text: "settings", enter: true });
});

test("keys that are not text pass through", () => {
  const held = { text: "a", enter: false };
  for (const key of ["Escape", "ArrowDown", "Tab", "Shift", "F5"]) assert.equal(typeaheadKey(held, key), null, key);
});

/** Runs `events` from closed; returns the gate and what each `ready` handed over. */
function run(events: PaletteEvent[]): { gate: PaletteGate; handed: Typeahead[] } {
  let gate = CLOSED;
  const handed: Typeahead[] = [];
  for (const e of events) {
    const out = paletteStep(gate, e);
    gate = out.gate;
    if (e.type === "ready" && out.typed) handed.push(out.typed);
  }
  return { gate, handed };
}
const keys = (s: string): PaletteEvent[] => chars(s).map((key) => ({ type: "key", key }));

test("NEW-7: keys typed while a palette opens are handed to that palette once", () => {
  const { gate, handed } = run([{ type: "toggle" }, ...keys("billing"), { type: "ready", id: 1 }, { type: "ready", id: 1 }]);
  assert.equal(gate.phase, "open");
  assert.deepEqual(handed, [
    { text: "billing", enter: false },
    { text: "", enter: false },
  ]);
});

test("NEW-7: 50 rapid Ctrl+K / Esc / Ctrl+K, then typing: the last palette gets every key, whatever the earlier ones do late", () => {
  const events: PaletteEvent[] = [];
  for (let i = 1; i <= 50; i++) {
    events.push({ type: "toggle" });
    // Half the opens are cancelled by Esc before the palette took focus, half after.
    if (i % 2) events.push({ type: "key", key: "Escape" });
    else events.push({ type: "ready", id: i }, { type: "close", id: i });
  }
  events.push({ type: "toggle" }, ...keys("billing"));
  // Late calls of the earlier palettes: a close, a ready, an exit.
  events.push({ type: "close", id: 50 }, { type: "ready", id: 49 }, { type: "exited", id: 50 });
  events.push({ type: "ready", id: 51 });
  const { gate, handed } = run(events);
  assert.equal(gate.id, 51);
  assert.equal(gate.phase, "open");
  assert.deepEqual(handed.at(-1), { text: "billing", enter: false });
});

test("NEW-7: a reopen while the last palette is closing makes a new palette; closing discards only the closing one's keys", () => {
  let { gate } = run([{ type: "toggle" }, ...keys("ab"), { type: "toggle" }]);
  assert.equal(gate.phase, "closing");
  assert.equal(gate.held.text, "");
  gate = paletteStep(gate, { type: "toggle" }).gate;
  assert.deepEqual([gate.phase, gate.id], ["opening", 2]);
  for (const e of keys("settings")) gate = paletteStep(gate, e).gate;
  gate = paletteStep(gate, { type: "key", key: "Enter" }).gate;
  // The first palette's exit ends late: nothing changes for the second.
  gate = paletteStep(gate, { type: "exited", id: 1 }).gate;
  assert.deepEqual(paletteStep(gate, { type: "ready", id: 2 }).typed, { text: "settings", enter: true });
});

test("NEW-7: keys pass through when no palette is opening; Escape while opening cancels it", () => {
  assert.equal(paletteStep(CLOSED, { type: "key", key: "a" }).consumed, undefined);
  const opening = paletteStep(CLOSED, { type: "open" }).gate;
  assert.equal(paletteStep(opening, { type: "key", key: "ArrowDown" }).consumed, undefined);
  const esc = paletteStep(opening, { type: "key", key: "Escape" });
  assert.equal(esc.consumed, true);
  assert.equal(esc.gate.phase, "closing");
  // `open` while one shows does nothing.
  assert.equal(paletteStep(opening, { type: "open" }).gate, opening);
});
