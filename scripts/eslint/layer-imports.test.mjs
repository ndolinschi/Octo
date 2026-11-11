import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { allows, layerOf } from "./layer-imports.mjs";

const layer = (rel) => layerOf(rel.split("/").join(path.sep));

test("layerOf classifies paths under packages/ui/src", () => {
  assert.equal(layer("index.ts"), "root");
  assert.equal(layer("lib/files.ts"), "lib");
  assert.equal(layer("state/workspace/layout.ts"), "state");
  assert.equal(layer("components/primitives/Button.tsx"), "primitives");
  assert.equal(layer("components/shared/Markdown.tsx"), "shared");
  assert.equal(layer("components/dock/Dock.tsx"), "dock");
  assert.equal(layer("components/files/FileView.tsx"), "feature:files");
  assert.equal(layer("demo/bridge.ts"), "demo");
});

test("each layer reaches only the layers below it", () => {
  assert.ok(allows("state", "lib"));
  assert.ok(allows("state", "lsp"));
  assert.ok(!allows("state", "feature:files"));
  assert.ok(!allows("lib", "state"));
  assert.ok(!allows("lsp", "state"));
  assert.ok(!allows("primitives", "state"));
  assert.ok(allows("shared", "state"));
  assert.ok(!allows("shared", "feature:chat"));
});

test("features meet only through the dock", () => {
  assert.ok(allows("feature:files", "feature:files"));
  assert.ok(!allows("feature:files", "feature:chat"));
  assert.ok(!allows("feature:files", "dock"));
  assert.ok(allows("feature:chat", "shared"));
  assert.ok(allows("dock", "feature:files"));
  assert.ok(allows("app", "dock"));
  assert.ok(!allows("dock", "app"));
});

test("the package root and the demo stay apart", () => {
  assert.ok(allows("root", "app"));
  assert.ok(!allows("root", "demo"));
  assert.ok(!allows("app", "demo"));
  assert.ok(allows("demo", "lsp"));
  assert.ok(!allows("demo", "state"));
});
