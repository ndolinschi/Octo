import assert from "node:assert/strict";
import test from "node:test";
import { chooseBridge } from "./bridgeChoice";
import { parseConnection } from "./hostConnection";

test("the shell's command returns { url, token }", () => {
  assert.deepEqual(parseConnection({ url: "http://127.0.0.1:51234", token: "abc" }), { url: "http://127.0.0.1:51234", token: "abc" });
});

test("a bare URL string (an older shell) means no token; a missing token is empty", () => {
  assert.deepEqual(parseConnection("http://127.0.0.1:51234"), { url: "http://127.0.0.1:51234", token: "" });
  assert.deepEqual(parseConnection({ url: "http://h" }), { url: "http://h", token: "" });
});

test("anything else is an error", () => {
  for (const bad of [null, undefined, 3, {}, { token: "t" }, { url: "" }, { url: 5 }]) {
    let message = "";
    try {
      parseConnection(bad);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    assert.equal(message, "the desktop shell returned no bridge URL");
  }
});

test("the host token goes with the host URL", () => {
  assert.deepEqual(chooseBridge("", {}, "http://127.0.0.1:51234/", "tok"), { kind: "http", baseUrl: "http://127.0.0.1:51234", token: "tok" });
  assert.deepEqual(chooseBridge("", {}, "http://127.0.0.1:51234", ""), { kind: "http", baseUrl: "http://127.0.0.1:51234" });
  assert.deepEqual(chooseBridge("", { VITE_HARNESS_API_TOKEN: "from-env" }, "http://127.0.0.1:51234", null), {
    kind: "http",
    baseUrl: "http://127.0.0.1:51234",
  });
});

test("without a host URL the dev token is VITE_HARNESS_API_TOKEN", () => {
  assert.deepEqual(chooseBridge("", { VITE_HARNESS_API_TOKEN: " dev-token " }), { kind: "http", baseUrl: "http://127.0.0.1:8790", token: "dev-token" });
  assert.deepEqual(chooseBridge("", { HARNESS_API_TOKEN: "plain" }), { kind: "http", baseUrl: "http://127.0.0.1:8790", token: "plain" });
  assert.deepEqual(chooseBridge("", {}), { kind: "http", baseUrl: "http://127.0.0.1:8790" });
  assert.equal(chooseBridge("?demo=1", { VITE_HARNESS_API_TOKEN: "x" }).kind, "demo");
});
