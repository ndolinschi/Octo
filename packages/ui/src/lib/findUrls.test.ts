import assert from "node:assert/strict";
import test from "node:test";
import { findUrls, newestUrl } from "./findUrls";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test("a link wrapped in colour codes is found whole", () => {
  const out = `Open this link:\r\n${ESC}[1;34mhttps://claude.ai/oauth/authorize?client_id=abc&state=x${ESC}[0m\r\nPaste the code.`;
  assert.deepEqual(findUrls(out), ["https://claude.ai/oauth/authorize?client_id=abc&state=x"]);
});

test("trailing punctuation of a sentence is not part of the link", () => {
  assert.deepEqual(findUrls("Go to https://example.com/login, then wait."), ["https://example.com/login"]);
  assert.deepEqual(findUrls("(see https://example.com/a/b)."), ["https://example.com/a/b"]);
});

test("links come in order, each once, and a link printed again is the newest", () => {
  const out = "first http://a.test/1\nsecond https://b.test/2\nagain http://a.test/1\n";
  assert.deepEqual(findUrls(out), ["https://b.test/2", "http://a.test/1"]);
  assert.equal(newestUrl(out), "http://a.test/1");
});

test("an OSC 8 hyperlink sequence leaves just the address", () => {
  const out = `${ESC}]8;;https://x.test/open${BEL}click${ESC}]8;;${BEL} or https://x.test/open`;
  assert.deepEqual(findUrls(out), ["https://x.test/open"]);
});

test("no link, no result", () => {
  assert.deepEqual(findUrls(""), []);
  assert.equal(newestUrl("nothing here, ftp://x.test is not offered"), null);
});
