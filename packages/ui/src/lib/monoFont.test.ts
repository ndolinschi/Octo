import assert from "node:assert/strict";
import test from "node:test";
import { MONO_FALLBACK, monoFont } from "./monoFont";

test("monoFont reads the --font-mono token", () => {
  const root = { getPropertyValue: (n: string) => (n === "--font-mono" ? ' "Iosevka", monospace ' : "") };
  assert.equal(monoFont(root), '"Iosevka", monospace');
});

test("monoFont falls back to the token's literal when the token is missing or there is no document", () => {
  assert.equal(monoFont({ getPropertyValue: () => "" }), MONO_FALLBACK);
  assert.equal(monoFont(null), MONO_FALLBACK);
  assert.equal(monoFont(), MONO_FALLBACK);
});
