import assert from "node:assert/strict";
import test from "node:test";
import { compactionLabel } from "./compact";
import { compactedLine, compactError } from "./compactNow";

test("compacted line names the messages and the summary", () => {
  assert.equal(compactedLine({ message_count: 14, summary_tokens: 1200 }), "Compacted 14 messages into a summary of about 1.2k tokens.");
  assert.equal(compactedLine({ message_count: 1, summary_tokens: 0 }), "Compacted 1 message.");
  assert.equal(compactedLine({ message_count: 0, summary_tokens: 300 }), "Compacted the history into a summary of about 300 tokens.");
});

test("errors have a next step or fall through", () => {
  assert.match(compactError("nothing_to_compact") ?? "", /fewer than two/);
  assert.match(compactError("compact_unsupported") ?? "", /own history/);
  assert.equal(compactError("other"), null);
});

test("marker label", () => {
  assert.equal(compactionLabel({}), "History compacted");
  assert.equal(compactionLabel({ label: "history compacted", manual: true }), "History compacted · manual");
  assert.equal(compactionLabel({ label: "Rewound to here" }), "Rewound to here");
});
