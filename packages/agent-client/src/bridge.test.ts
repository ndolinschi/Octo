import assert from "node:assert/strict";
import test from "node:test";
import { resolveBridgeUrl } from "./bridge";
import { DEFAULT_BRIDGE_URL } from "./types";

test("resolveBridgeUrl prefers VITE_HARNESS_BRIDGE_URL", () => {
  assert.equal(
    resolveBridgeUrl({
      VITE_HARNESS_BRIDGE_URL: "http://localhost:9000",
      HARNESS_BRIDGE_URL: "http://ignored",
    }),
    "http://localhost:9000",
  );
});

test("resolveBridgeUrl falls back to default", () => {
  assert.equal(resolveBridgeUrl({}), DEFAULT_BRIDGE_URL);
});

test("resolveBridgeUrl strips trailing slash", () => {
  assert.equal(resolveBridgeUrl({ VITE_HARNESS_BRIDGE_URL: "http://localhost:8790/" }), "http://localhost:8790");
});
