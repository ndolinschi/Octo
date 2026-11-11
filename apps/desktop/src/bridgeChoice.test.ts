import assert from "node:assert/strict";
import test from "node:test";
import { bridgeLabel, chooseBridge } from "./bridgeChoice";

test("no demo parameter: the harness at the default URL", () => {
  assert.deepEqual(chooseBridge("", {}), { kind: "http", baseUrl: "http://127.0.0.1:8790" });
  assert.deepEqual(chooseBridge("?lsp=slow", {}), { kind: "http", baseUrl: "http://127.0.0.1:8790" });
});

test("VITE_HARNESS_BRIDGE_URL overrides the URL, without a trailing slash", () => {
  const env = { VITE_HARNESS_BRIDGE_URL: "http://localhost:9000/" };
  assert.deepEqual(chooseBridge("", env), { kind: "http", baseUrl: "http://localhost:9000" });
});

test("an empty demo parameter is not the demo", () => {
  assert.equal(chooseBridge("?demo=", {}).kind, "http");
});

test("any non-empty demo parameter is the demo with the full seed, ok language server and plugins", () => {
  assert.deepEqual(chooseBridge("?demo=1", {}), { kind: "demo", options: { seed: "full", lsp: "ok", plugins: true } });
  assert.deepEqual(chooseBridge("?demo=whatever", {}), { kind: "demo", options: { seed: "full", lsp: "ok", plugins: true } });
});

test("the demo ignores the bridge URL override", () => {
  const choice = chooseBridge("?demo=1", { VITE_HARNESS_BRIDGE_URL: "http://localhost:9000" });
  assert.equal(choice.kind, "demo");
});

test("demo seeds", () => {
  for (const seed of ["empty", "one", "many"] as const) {
    assert.deepEqual(chooseBridge(`?demo=${seed}`, {}), { kind: "demo", options: { seed, lsp: "ok", plugins: true } });
  }
});

test("demo knobs: lsp modes and plugins=none", () => {
  for (const lsp of ["fail-once", "slow", "exit"] as const) {
    assert.deepEqual(chooseBridge(`?demo=1&lsp=${lsp}`, {}), { kind: "demo", options: { seed: "full", lsp, plugins: true } });
  }
  assert.deepEqual(chooseBridge("?demo=1&lsp=bogus&plugins=none", {}), { kind: "demo", options: { seed: "full", lsp: "ok", plugins: false } });
  assert.deepEqual(chooseBridge("?demo=1&plugins=yes", {}), { kind: "demo", options: { seed: "full", lsp: "ok", plugins: true } });
});

test("bridgeLabel", () => {
  assert.equal(bridgeLabel({ kind: "demo", options: {} }), "demo");
  assert.equal(bridgeLabel({ kind: "http", baseUrl: "http://x" }), "http://x");
});
