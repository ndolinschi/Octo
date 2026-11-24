import assert from "node:assert/strict";
import test from "node:test";
import { nextTranscriptView, transcriptViewCodec } from "./transcriptView";

test("transcriptView cycles normal -> thinking -> verbose -> normal", () => {
  assert.equal(nextTranscriptView("normal"), "thinking");
  assert.equal(nextTranscriptView("thinking"), "verbose");
  assert.equal(nextTranscriptView("verbose"), "normal");
});

test("transcriptViewCodec parses valid modes and falls back to normal", () => {
  assert.equal(transcriptViewCodec.parse("thinking"), "thinking");
  assert.equal(transcriptViewCodec.parse("verbose"), "verbose");
  assert.equal(transcriptViewCodec.parse("unknown"), "normal");
  assert.equal(transcriptViewCodec.parse(null), "normal");
});
