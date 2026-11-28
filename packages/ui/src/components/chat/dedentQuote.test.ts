import assert from "node:assert/strict";
import test from "node:test";
import { dedentQuote } from "./dedentQuote";

test("dedentQuote strips shared leading indentation while preserving relative nesting", () => {
  assert.deepEqual(dedentQuote([]), []);
  assert.deepEqual(dedentQuote(['        "enum_validation": {']), ['"enum_validation": {']);
  assert.deepEqual(dedentQuote(["    if (ok) {", "      return 1;", "   ", "    }"]), ["if (ok) {", "  return 1;", "", "}"]);
  assert.deepEqual(dedentQuote(["\t\tconst a = 1;", "\t\t\tconst b = 2;"]), ["const a = 1;", "  const b = 2;"]);
  assert.deepEqual(dedentQuote(["const a = 1;", "  const b = 2;"]), ["const a = 1;", "  const b = 2;"]);
  assert.deepEqual(dedentQuote(["   ", "\t"]), ["", ""]);
});
