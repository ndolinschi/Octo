import assert from "node:assert/strict";
import test from "node:test";
import { languageOfPath, languagesIn } from "./languages";

test("language by extension, case-insensitive; dotfiles and unknown are none", () => {
  assert.equal(languageOfPath("src/a.TS"), "typescript");
  assert.equal(languageOfPath("cmd/main.go"), "go");
  assert.equal(languageOfPath(".env"), null);
  assert.equal(languageOfPath("Makefile"), null);
  assert.equal(languageOfPath("x.unknown"), null);
});

test("languages present in a set of paths", () => {
  assert.deepEqual([...languagesIn(["a.ts", "b.tsx", "c.go", "README"])].sort(), ["go", "typescript"]);
});
