import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_ENVELOPE_BYTES, MESSAGE_MAX_BYTES } from "./composerInput";
import { formatBytes, jsonByteLength, messageSize, tooLongText } from "./messageSize";

test("jsonByteLength equals the UTF-8 length of JSON.stringify", () => {
  for (const s of [
    "",
    "plain",
    'quote " and \\ slash',
    "tab\tnew\nline\r",
    "\u0001\u001f",
    "ünïcödé",
    "日本語",
    "emoji 😀 pair",
    "lone \ud800 surrogate",
    "low \udc00 alone",
  ]) {
    assert.equal(jsonByteLength(s), new TextEncoder().encode(JSON.stringify(s)).length, JSON.stringify(s));
  }
});

test("messageSize: nothing counted while surely small; near and over the limit", () => {
  assert.equal(messageSize("hello"), null);
  assert.equal(messageSize("x".repeat(100_000)), null, "100k characters cannot reach 1 MiB (6 bytes each at most)");
  const near = messageSize("x".repeat(900_000));
  assert.ok(near?.near && !near.over);
  const over = messageSize("x".repeat(2_400_000));
  assert.ok(over?.over);
  assert.equal(over.limit, MESSAGE_MAX_BYTES - MESSAGE_ENVELOPE_BYTES);
  const multibyte = messageSize("ж".repeat(600_000));
  assert.ok(multibyte?.over, "two bytes a character: 600k Cyrillic letters are over");
});

test("formatBytes and the refusal text", () => {
  assert.equal(formatBytes(MESSAGE_MAX_BYTES), "1 MB");
  assert.equal(formatBytes(2_516_582), "2.4 MB");
  assert.equal(formatBytes(830_000), "811 KB");
  assert.equal(
    tooLongText(2_516_582),
    "This message is too long to send (2.4 MB; the limit is 1 MB). Save it as a file in the project and mention it with @ instead.",
  );
});
