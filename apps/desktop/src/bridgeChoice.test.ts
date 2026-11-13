import assert from "node:assert/strict";
import test from "node:test";
import { bridgeLabel, chooseBridge, isTauri, usesHostBridge } from "./bridgeChoice";

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

test("a host URL (the Tauri shell's harness) beats the default and the environment, without a trailing slash", () => {
  assert.deepEqual(chooseBridge("", {}, "http://127.0.0.1:51234/"), { kind: "http", baseUrl: "http://127.0.0.1:51234" });
  assert.deepEqual(chooseBridge("", { VITE_HARNESS_BRIDGE_URL: "http://localhost:9000" }, "http://127.0.0.1:51234"), {
    kind: "http",
    baseUrl: "http://127.0.0.1:51234",
  });
  assert.equal(chooseBridge("", {}, null).kind, "http");
  assert.deepEqual(chooseBridge("", {}, ""), { kind: "http", baseUrl: "http://127.0.0.1:8790" });
});

test("the demo ignores the host URL", () => {
  assert.equal(chooseBridge("?demo=1", {}, "http://127.0.0.1:51234").kind, "demo");
});

test("isTauri looks for the injected internals", () => {
  assert.equal(isTauri(undefined), false);
  assert.equal(isTauri({}), false);
  assert.equal(isTauri({ __TAURI_INTERNALS__: {} }), true);
});

test("usesHostBridge: only inside Tauri, not the demo, not with an explicit bridge URL", () => {
  assert.equal(usesHostBridge("", {}, true), true);
  assert.equal(usesHostBridge("", {}, false), false);
  assert.equal(usesHostBridge("?demo=1", {}, true), false);
  assert.equal(usesHostBridge("?demo=", {}, true), true);
  assert.equal(usesHostBridge("", { VITE_HARNESS_BRIDGE_URL: "http://localhost:9000" }, true), false);
  assert.equal(usesHostBridge("", { VITE_HARNESS_BRIDGE_URL: "" }, true), true);
});
