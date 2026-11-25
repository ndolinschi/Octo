import assert from "node:assert/strict";
import test from "node:test";
import { guessOneLine, promptShape, rememberPromptShape } from "./promptShape";

test("guessOneLine: short text with no line break, then what the measurements teach", () => {
  assert.equal(guessOneLine("Run the tests"), true);
  assert.equal(guessOneLine(""), false);
  assert.equal(guessOneLine("two\nlines"), false);
  const long = "x".repeat(50);
  assert.equal(guessOneLine(long), false);
  // A wide column: a 60-character request was one line.
  rememberPromptShape("y".repeat(60), { oneLine: true, overflows: false });
  assert.equal(guessOneLine(long), true);
  // The column narrowed: a 40-character one wrapped.
  rememberPromptShape("z".repeat(40), { oneLine: false, overflows: false });
  assert.equal(guessOneLine(long), false);
  assert.equal(guessOneLine("w".repeat(39)), true);
  // A text with a break teaches nothing about the width.
  rememberPromptShape("a\nb", { oneLine: false, overflows: false });
  assert.equal(guessOneLine("w".repeat(39)), true);
});

test("rememberPromptShape keeps the last measurement and forgets the oldest past its bound", () => {
  rememberPromptShape("a", { oneLine: true, overflows: false });
  rememberPromptShape("a", { oneLine: false, overflows: true });
  assert.deepEqual(promptShape("a"), { oneLine: false, overflows: true });
  for (let i = 0; i < 500; i++) rememberPromptShape(`k${i}`, { oneLine: true, overflows: false });
  assert.equal(promptShape("a"), undefined);
  assert.deepEqual(promptShape("k499"), { oneLine: true, overflows: false });
});
