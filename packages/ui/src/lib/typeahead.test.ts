import assert from "node:assert/strict";
import test from "node:test";
import { typeaheadKey, type Typeahead } from "./typeahead";

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
