import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDuration,
  basename,
  errorMessage,
  excerpt,
  formatDuration,
  formatRelative,
  formatSeparator,
  formatTokens,
  middleTruncate,
  needsSeparator,
  timeAgo,
} from "./format";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

test("separator after a 30-minute pause or a new day, and before the first request", () => {
  assert.equal(needsSeparator(null, at(2026, 11, 10, 9)), true);
  assert.equal(needsSeparator(at(2026, 11, 10, 9), at(2026, 11, 10, 9, 20)), false);
  assert.equal(needsSeparator(at(2026, 11, 10, 9), at(2026, 11, 10, 9, 31)), true);
  assert.equal(needsSeparator(at(2026, 11, 9, 23, 50), at(2026, 11, 10, 0, 5)), true);
});

test("Today / Yesterday / date, locale time", () => {
  const now = Date.parse(at(2026, 11, 10, 15));
  assert.match(formatSeparator(at(2026, 11, 10, 10), now, "en-GB"), /^Today 10:00$/);
  assert.match(formatSeparator(at(2026, 11, 9, 18, 42), now, "en-GB"), /^Yesterday 18:42$/);
  assert.match(formatSeparator(at(2026, 11, 6, 9, 15), now, "en-GB"), /^6 Nov, 0?9:15$/);
  assert.match(formatSeparator(at(2025, 11, 6, 9, 15), now, "en-GB"), /2025/);
});

test("separator boundary: exactly 30 minutes is not a gap, and a turn across midnight within 30 min still is", () => {
  assert.equal(needsSeparator(at(2026, 11, 10, 9), at(2026, 11, 10, 9, 30)), false);
  assert.equal(needsSeparator(at(2026, 11, 10, 23, 55), at(2026, 11, 11, 0, 5)), true);
  assert.equal(needsSeparator(at(2026, 11, 10, 9, 30), at(2026, 11, 10, 9)), false, "a start before the previous end is no gap");
});

test("durations: seconds, minutes, hours; never negative", () => {
  assert.equal(formatDuration(-5000), "0s");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_600_000), "1h 00m");
  assert.equal(formatDuration(26 * 3_600_000 + 5 * 60_000), "26h 05m");
});

test("agentDuration: not started is null; a running agent counts to now", () => {
  const now = Date.parse("2026-11-10T10:00:00Z");
  assert.equal(agentDuration({ started_at: null, finished_at: null }, now), null);
  assert.equal(agentDuration({ started_at: "2026-11-10T09:59:00Z", finished_at: null }, now), 60_000);
  assert.equal(agentDuration({ started_at: "2026-11-10T09:00:00Z", finished_at: "2026-11-10T09:00:30Z" }, now), 30_000);
});

test("relative time: now, minutes, hours, days, then a date; the future reads as now", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(formatRelative(ago(30_000), now), "now");
  assert.equal(formatRelative(ago(60_000), now), "1m");
  assert.equal(formatRelative(ago(59 * 60_000), now), "59m");
  assert.equal(formatRelative(ago(60 * 60_000), now), "1h");
  assert.equal(formatRelative(ago(23 * 3_600_000), now), "23h");
  assert.equal(formatRelative(ago(24 * 3_600_000), now), "1d");
  assert.equal(formatRelative(ago(6 * 86_400_000), now), "6d");
  assert.doesNotMatch(formatRelative(ago(7 * 86_400_000), now), /^\d+[mhd]$/);
  assert.equal(formatRelative(new Date(now + 3_600_000).toISOString(), now), "now");
  assert.equal(timeAgo(ago(1000), now), "just now");
  assert.equal(timeAgo(ago(2 * 3_600_000), now), "2h ago");
  assert.doesNotMatch(timeAgo(ago(30 * 86_400_000), now), /ago/);
});

test("excerpt keeps prose, drops code fences, headings, bullets, tables and link targets", () => {
  const md =
    "# Title\n\nSome **bold** and `code` text with a [link](http://x.y).\n\n```ts\nconst hidden = 1;\n```\n\n- first\n- second\n\n| a | b |\n|---|---|\n\n> quoted";
  assert.equal(excerpt(md), "Title Some bold and code text with a link. first second quoted");
  assert.equal(excerpt(""), "");
});

test("excerpt cuts long text with an ellipsis within the limit", () => {
  const long = "word ".repeat(200);
  const out = excerpt(long, 50);
  assert.ok(out.length <= 50 && out.endsWith("\u2026"));
  assert.equal(excerpt("short", 50), "short");
  assert.equal(excerpt("日本語".repeat(100), 10).length, 10);
});

test("basename handles both separators, trailing slashes and the empty path", () => {
  assert.equal(basename("/a/b/c.ts"), "c.ts");
  assert.equal(basename("C:\\Users\\maya\\code\\"), "code");
  assert.equal(basename("plain"), "plain");
  assert.equal(basename("/"), "/");
});

test("middleTruncate keeps the end visible and never exceeds max", () => {
  assert.equal(middleTruncate("short.ts", 20), "short.ts");
  assert.equal(middleTruncate("exactly-twenty-chars", 20), "exactly-twenty-chars");
  const path = "packages/ui/src/components/files/editor/EditorComments.tsx";
  const out = middleTruncate(path, 32);
  assert.equal(out.length, 32);
  assert.ok(out.endsWith("/EditorComments.tsx") && out.includes("\u2026"), out);
  const bare = middleTruncate("a-very-long-file-name-without-any-slash.test.ts", 24);
  assert.equal(bare.length, 24);
  assert.ok(bare.endsWith("test.ts") || bare.endsWith(".test.ts"), bare);
  assert.equal(middleTruncate("日本語のとても長いファイル名.md", 10).length, 10);
});

test("token counts read quietly", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(820), "820");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(2400), "2.4k");
  assert.equal(formatTokens(24_000), "24k");
  assert.equal(formatTokens(1_200_000), "1.2M");
});

test("token counts roll over to the next unit instead of showing 1000 of the last", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(9_999), "10k");
  assert.equal(formatTokens(999_499), "999k");
  assert.equal(formatTokens(999_500), "1M");
  assert.equal(formatTokens(999_999), "1M");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(24_500_000), "24.5M");
  assert.equal(formatTokens(999_949_999), "999.9M");
  assert.equal(formatTokens(999_950_000), "1B");
  assert.equal(formatTokens(999_999_999), "1B");
  assert.equal(formatTokens(2_500_000_000), "2.5B");
  for (const n of [0, 1, 999, 1000, 9_999, 10_000, 99_999, 999_999, 1e6, 999_999_999, 1e9]) assert.doesNotMatch(formatTokens(n), /^1000/, String(n));
});

test("errorMessage: an Error's message, anything else by its string form", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage(new TypeError("bad")), "bad");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(404), "404");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
  assert.equal(errorMessage({ message: "not an Error" }), "[object Object]");
});
