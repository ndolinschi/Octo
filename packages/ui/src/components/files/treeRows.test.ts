import assert from "node:assert/strict";
import test from "node:test";
import type { FileEntry } from "@octo/agent-client";
import { fileKey, isRootKey, type FileKey } from "../../lib/files";
import { isNode, treeRows, typeAhead, type TreeDir } from "./treeRows";

const F = "app";
const folders = [{ label: F, path: "/w/app" }];
const dir = (path: string, chain?: string[]): FileEntry => ({ name: path.split("/").at(-1) ?? path, path, type: "dir", size: 0, ...(chain ? { chain } : {}) });
const file = (path: string): FileEntry => ({ name: path.split("/").at(-1) ?? path, path, type: "file", size: 1 });
const ready = (entries: FileEntry[]): TreeDir => ({ status: "ready", entries, error: null });

const PKG = "com/wsgc/ecommerce/product/configurator/management/data/subsystem";
const JAVA = "src/main/java";

/** What the tree has loaded with compact folders on: one listing per visible row. */
function loaded(): Record<string, TreeDir> {
  return {
    [fileKey(F, "")]: ready([dir("src", ["main", "java", ...PKG.split("/")]), file("pom.xml")]),
    [fileKey(F, JAVA)]: ready([dir(`${JAVA}/com`, PKG.split("/").slice(1))]),
    [fileKey(F, `${JAVA}/${PKG}`)]: ready([dir(`${JAVA}/${PKG}/config`), dir(`${JAVA}/${PKG}/mdm`), file(`${JAVA}/${PKG}/App.java`)]),
  };
}

const opened = (...paths: string[]) => {
  const set = new Set(paths.map((p) => fileKey(F, p)));
  return (k: FileKey) => set.has(k) || isRootKey(k);
};
const labels = (rows: ReturnType<typeof treeRows>) => rows.map((r) => (isNode(r) ? `${r.level}:${r.name}` : `${r.level}:<${r.kind}>`));

test("compact: the screenshot's three rows, one indent level each", () => {
  const rows = treeRows(folders, loaded(), opened(JAVA, `${JAVA}/${PKG}`), null, true);
  assert.deepEqual(labels(rows), [
    "1:app",
    "2:src/main/java",
    "3:com.wsgc.ecommerce.product.configurator.management.data.subsystem",
    "4:config",
    "4:mdm",
    "4:App.java",
    "2:pom.xml",
  ]);
  const pkg = rows[2];
  assert.ok(pkg && isNode(pkg));
  assert.equal(pkg.path, `${JAVA}/${PKG}`);
  assert.equal(pkg.head, `${JAVA}/com`);
  assert.equal(pkg.id, fileKey(F, `${JAVA}/${PKG}`));
  assert.equal(pkg.paths.length, 8);
  assert.equal(pkg.title, `${F}/${JAVA}/${PKG}`);
});

test("compact: a closed chain is closed by its last directory; an open one with no listing yet shows loading", () => {
  const closed = treeRows(folders, loaded(), opened(), null, true);
  assert.deepEqual(labels(closed), ["1:app", "2:src/main/java", "2:pom.xml"]);
  const dirs = Object.fromEntries(Object.entries(loaded()).filter(([k]) => k !== fileKey(F, JAVA)));
  assert.deepEqual(labels(treeRows(folders, dirs, opened(JAVA), null, true)), ["1:app", "2:src/main/java", "3:<loading>", "2:pom.xml"]);
});

test("off: one row per directory, exactly as before", () => {
  const dirs = {
    [fileKey(F, "")]: ready([dir("src", ["main"]), file("pom.xml")]),
    [fileKey(F, "src")]: ready([dir("src/main")]),
  };
  const rows = treeRows(folders, dirs, opened("src"), null, false);
  assert.deepEqual(labels(rows), ["1:app", "2:src", "3:main", "2:pom.xml"]);
  const main = rows[2];
  assert.ok(main && isNode(main));
  assert.deepEqual(main.paths, [main.path]);
  assert.equal(main.head, main.path);
});

test("compact: a file created mid-chain splits the row once its directory is listed again", () => {
  const dirs = loaded();
  // The live refresh reloads java (the nearest listed ancestor): com's hint now stops at ecommerce.
  dirs[fileKey(F, JAVA)] = ready([dir(`${JAVA}/com`, ["wsgc", "ecommerce"])]);
  const isOpen = opened(JAVA, ...["com", "com/wsgc", "com/wsgc/ecommerce", PKG].map((p) => `${JAVA}/${p}`));
  assert.deepEqual(labels(treeRows(folders, dirs, isOpen, null, true)).slice(0, 4), ["1:app", "2:src/main/java", "3:com.wsgc.ecommerce", "4:<loading>"]);
  dirs[fileKey(F, `${JAVA}/com/wsgc/ecommerce`)] = ready([
    dir(`${JAVA}/com/wsgc/ecommerce/product`, PKG.split("/").slice(4)),
    file(`${JAVA}/com/wsgc/ecommerce/Notes.java`),
  ]);
  assert.deepEqual(labels(treeRows(folders, dirs, isOpen, null, true)), [
    "1:app",
    "2:src/main/java",
    "3:com.wsgc.ecommerce",
    "4:product.configurator.management.data.subsystem",
    "5:config",
    "5:mdm",
    "5:App.java",
    "4:Notes.java",
    "2:pom.xml",
  ]);
});

test("compact while filtering: the chain row shows for a match below it, open", () => {
  const only = new Set([fileKey(F, ""), fileKey(F, "src"), fileKey(F, "src/main"), fileKey(F, JAVA)]);
  let p = JAVA;
  for (const seg of PKG.split("/")) {
    p = `${p}/${seg}`;
    only.add(fileKey(F, p));
  }
  only.add(fileKey(F, `${JAVA}/${PKG}/App.java`));
  assert.deepEqual(labels(treeRows(folders, loaded(), opened(), only, true)), [
    "1:app",
    "2:src/main/java",
    "3:com.wsgc.ecommerce.product.configurator.management.data.subsystem",
    "4:App.java",
  ]);
});

test("type-ahead: the next row whose name, or a compact row's segment, starts with the typed text", () => {
  const rows = treeRows(folders, loaded(), opened(JAVA, `${JAVA}/${PKG}`), null, true);
  const id = (i: number) => rows[i]?.id;
  assert.equal(typeAhead(rows, 0, "s"), id(1)); // src/main/java
  assert.equal(typeAhead(rows, 0, "java"), id(1)); // a later segment of the same row
  assert.equal(typeAhead(rows, 0, "subsys"), id(2)); // the package row's last segment
  assert.equal(typeAhead(rows, 0, "MD"), id(4)); // case-insensitive
  assert.equal(typeAhead(rows, 6, "a"), id(0)); // wraps to the root after pom.xml
  assert.equal(typeAhead(rows, 2, "s"), id(1)); // searching starts after the focused row and wraps
  assert.equal(typeAhead(rows, 0, "zzz"), undefined);
});
