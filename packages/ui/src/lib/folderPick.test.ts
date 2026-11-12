import assert from "node:assert/strict";
import test from "node:test";
import {
  folderLabels,
  browseOutcome,
  browseRow,
  chosenFrom,
  completion,
  folderName,
  looksLikePath,
  mergeRecent,
  parentOf,
  rememberFolder,
  tildePath,
} from "./folderPick";

test("looksLikePath", () => {
  assert.ok(looksLikePath("/Users"));
  assert.ok(looksLikePath("~/code"));
  assert.ok(looksLikePath("C:\\\\work"));
  assert.ok(!looksLikePath("atlas"));
  assert.ok(!looksLikePath(""));
});

test("parentOf and folderName", () => {
  assert.equal(parentOf("/Users/maya/code/atlas"), "/Users/maya/code");
  assert.equal(parentOf("/Users/maya/code/atlas/"), "/Users/maya/code");
  assert.equal(parentOf("/x"), "");
  assert.equal(folderName("/Users/maya/code/atlas/"), "atlas");
  assert.equal(folderName("atlas"), "atlas");
});

test("mergeRecent: chosen first, then the harness's, once each, at most 8", () => {
  const h = [
    { name: "atlas", path: "/a/atlas", git: { branch: "main" } },
    { name: "docs", path: "/a/docs", git: null },
  ];
  const out = mergeRecent(["/a/docs/", "/b/new"], h);
  assert.deepEqual(
    out.map((e) => e.path),
    ["/a/docs/", "/b/new", "/a/atlas"],
  );
  assert.equal(
    mergeRecent(
      Array.from({ length: 12 }, (_, i) => `/p${i}`),
      h,
    ).length,
    8,
  );
  assert.equal(out[2]?.git?.branch, "main");
});

test("remember, stored list and completion", () => {
  assert.deepEqual(rememberFolder(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(chosenFrom(["/a", 3, ""]), ["/a"]);
  assert.deepEqual(chosenFrom(null), []);
  assert.equal(completion("/Users/maya"), "/Users/maya/");
  assert.equal(completion("/Users/"), "/Users/");
});

test("tildePath shortens the home folder on every platform", () => {
  assert.equal(tildePath("/Users/maya/code/atlas"), "~/code/atlas");
  assert.equal(tildePath("/home/maya"), "~");
  assert.equal(tildePath("C:\\Users\\maya\\code"), "~\\code");
  assert.equal(tildePath("/srv/data"), "/srv/data");
  assert.equal(tildePath("/Users/mayaX"), "~");
});

test("browseOutcome: a path is chosen, a cancel is not an error, a failure says why", () => {
  assert.deepEqual(browseOutcome("/Users/maya/code"), { kind: "chosen", path: "/Users/maya/code" });
  assert.deepEqual(browseOutcome(null), { kind: "cancelled" });
  assert.deepEqual(browseOutcome({ path: "/x" }), { kind: "chosen", path: "/x" });
  assert.deepEqual(browseOutcome({ cancelled: true }), { kind: "cancelled" });
  assert.deepEqual(browseOutcome({ error: "no_dialog", message: "No display." }), { kind: "error", message: "No display." });
  assert.deepEqual(browseOutcome({ error: "no_dialog" }), { kind: "error", message: "The folder dialog could not be opened." });
});

test("browseRow: idle shows the shortcut, busy waits and cannot be pressed again, an error shows under it", () => {
  assert.deepEqual(browseRow({ busy: false, error: null }, "Ctrl+O"), { label: "Browse…", hint: "Ctrl+O", busy: false, disabled: false, error: null });
  assert.deepEqual(browseRow({ busy: true, error: "old" }, "Ctrl+O"), {
    label: "Waiting for the folder dialog…",
    hint: "",
    busy: true,
    disabled: true,
    error: null,
  });
  assert.equal(browseRow({ busy: false, error: "No display." }, "Ctrl+O").error, "No display.");
});

test("folderLabels: a folder is named after itself; the parent only breaks a tie", () => {
  assert.deepEqual(folderLabels(["/a/atlas-api", "/a/atlas-web"]), ["atlas-api", "atlas-web"]);
  assert.deepEqual(folderLabels(["/work/web/app", "/work/mobile/app", "/x/other"]), ["app (web)", "app (mobile)", "other"]);
});
