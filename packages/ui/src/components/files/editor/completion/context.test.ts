import assert from "node:assert/strict";
import test from "node:test";
import { cutPrefix, cutSuffix, fileExclusion, FILE_MAX, isSecretPath, looksBinary, skipNow } from "./context";
import { StatusStore, stateAfterError, statusText } from "./status";

test("the prefix is cut on a line start, keeping the cursor's line whole", () => {
  const text = "aaaa\nbbbb\ncccc\ndd";
  assert.equal(cutPrefix(text, 100), text);
  assert.equal(cutPrefix(text, 6), "dd", "a window starting inside 'cccc' drops that line");
  assert.equal(cutPrefix(text, 7), "cccc\ndd", "a window starting at a line start keeps it");
  assert.equal(cutPrefix("x".repeat(50), 10), "x".repeat(50), "the cursor's line alone is longer than the limit");
  assert.equal(cutPrefix("ab\n" + "x".repeat(50), 10), "x".repeat(50));
});

test("the suffix is cut on a line end, keeping the rest of the cursor's line", () => {
  const text = "rest\nline2\nline3\n";
  assert.equal(cutSuffix(text, 100), text);
  assert.equal(cutSuffix(text, 12), "rest\nline2");
  assert.equal(cutSuffix(text, 10), "rest\nline2");
  assert.equal(cutSuffix("y".repeat(40) + "\nz", 10), "y".repeat(40));
  assert.equal(cutSuffix("y".repeat(40), 10), "y".repeat(40));
});

test("secret-like files are never sent", () => {
  for (const p of [
    ".env",
    ".env.local",
    "config/.ENV.production",
    "certs/server.pem",
    "tls.key",
    "home/id_ed25519",
    "id_rsa.pub",
    ".git/config",
    "a/.git/HEAD",
    "x.p12",
  ]) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ["src/env.ts", "docs/keys.md", "environment.go", "src/identity.ts", ".gitignore", "git/notes.md", "key.ts"]) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test("a file is excluded for secrets, size, binary content and read-only, in that order", () => {
  const base = { path: "src/a.ts", size: 100, sample: "const a = 1;", readOnly: false };
  assert.equal(fileExclusion(base), null);
  assert.match(fileExclusion({ ...base, path: ".env" }) ?? "", /secrets/);
  assert.match(fileExclusion({ ...base, size: FILE_MAX + 1 }) ?? "", /1 MB/);
  assert.match(fileExclusion({ ...base, sample: `PNG${String.fromCharCode(0)}x` }) ?? "", /binary/);
  assert.match(fileExclusion({ ...base, readOnly: true }) ?? "", /read-only/);
  assert.equal(looksBinary("plain"), false);
});

test("no request inside a selection, during an IME composition or while the suggestion list is open", () => {
  const none = { selection: false, composing: false, suggestListOpen: false };
  assert.equal(skipNow(none), false);
  assert.equal(skipNow({ ...none, selection: true }), true);
  assert.equal(skipNow({ ...none, composing: true }), true);
  assert.equal(skipNow({ ...none, suggestListOpen: true }), true);
});

test("errors turn completion off, or pause it with a reason", () => {
  const now = 1000;
  assert.equal(stateAfterError({ code: "completion_off", message: "x" }, now).kind, "off");
  const budget = stateAfterError({ code: "budget_reached" }, now);
  assert.equal(budget.kind, "paused");
  assert.match(statusText(budget).title, /budget/);
  const failed = stateAfterError(new Error("upstream 502"), now);
  assert.ok(failed.kind === "paused" && failed.until > now);
  assert.match(statusText(failed).title, /upstream 502/);
});

test("the status store notifies only on a change", () => {
  const store = new StatusStore();
  let n = 0;
  const off = store.subscribe(() => n++);
  store.set("k", { kind: "ready", model: "m" });
  store.set("k", { kind: "ready", model: "m" });
  store.set("k", { kind: "thinking", model: "m" });
  store.set("k", null);
  store.set("k", null);
  off();
  store.set("k", { kind: "ready", model: "m" });
  assert.equal(n, 3);
  assert.equal(store.get("k")?.kind, "ready");
});
