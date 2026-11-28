import assert from "node:assert/strict";
import test from "node:test";
import { fileKey } from "../lib/files";
import { isDirExpanded, nearestListedAncestor, normalizeWorkspaceId, planFileChanged, planRefreshDirs, type ListedDir } from "./dirCache";

const dir = (count: number): ListedDir => ({ entries: Array.from({ length: count }) });

test("normalizeWorkspaceId maps empty and shared to undefined and preserves worktree ids", () => {
  assert.equal(normalizeWorkspaceId(undefined), undefined);
  assert.equal(normalizeWorkspaceId(null), undefined);
  assert.equal(normalizeWorkspaceId(""), undefined);
  assert.equal(normalizeWorkspaceId("shared"), undefined);
  assert.equal(normalizeWorkspaceId("wrk_123"), "wrk_123");
});

test("isDirExpanded defaults roots to expanded and subfolders to collapsed", () => {
  assert.equal(isDirExpanded({}, fileKey("app", "")), true);
  assert.equal(isDirExpanded({ [fileKey("app", "")]: false }, fileKey("app", "")), false);
  assert.equal(isDirExpanded({}, fileKey("app", "src")), false);
  assert.equal(isDirExpanded({ [fileKey("app", "src")]: true }, fileKey("app", "src")), true);
});

test("planFileChanged evicts a listed collapsed directory so expanding it reloads newly added files", () => {
  const srcKey = fileKey("app", "src/components");
  const dirs = { [fileKey("app", "")]: dir(3), [srcKey]: dir(4) };
  const plan = planFileChanged(dirs, {}, "app", "src/components/NewCard.tsx");
  assert.equal(plan.dirPath, "src/components");
  assert.equal(plan.shown, false);
  assert.deepEqual(plan.evict, [srcKey]);
});

test("planFileChanged reloads an expanded listed directory and does not evict it", () => {
  const srcKey = fileKey("app", "src");
  const dirs = { [fileKey("app", "")]: dir(2), [srcKey]: dir(3) };
  const plan = planFileChanged(dirs, { [srcKey]: true }, "app", "src/added.ts");
  assert.equal(plan.shown, true);
  assert.deepEqual(plan.evict, []);
});

test("nearestListedAncestor walks up to the closest listed parent or root", () => {
  const rootKey = fileKey("app", "");
  const srcKey = fileKey("app", "src");
  const dirs = { [rootKey]: dir(2), [srcKey]: dir(3) };
  assert.deepEqual(nearestListedAncestor(dirs, "app", "src/new/sub"), { path: "src", key: srcKey });
  assert.deepEqual(nearestListedAncestor(dirs, "app", "docs/guides"), { path: "", key: rootKey });
  assert.equal(nearestListedAncestor(dirs, "app", ""), null);
});

test("planRefreshDirs reloads expanded dirs (including roots) and evicts collapsed dirs", () => {
  const rootKey = fileKey("app", "");
  const openKey = fileKey("app", "src");
  const closedKey = fileKey("app", "docs");
  const dirs = { [rootKey]: dir(2), [openKey]: dir(5), [closedKey]: dir(1) };
  const plan = planRefreshDirs(dirs, { [openKey]: true, [closedKey]: false });
  assert.deepEqual(plan.reload, [
    { folder: "app", path: "" },
    { folder: "app", path: "src" },
  ]);
  assert.deepEqual(plan.evict, [closedKey]);
});
