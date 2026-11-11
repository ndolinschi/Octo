import assert from "node:assert/strict";
import test from "node:test";
import { prompts } from "./starters";

test("starters are specific to the project (decision 52): they name its folder, none without one", () => {
  assert.deepEqual(prompts({ folders: [] }), []);
  const p = prompts({ folders: [{ id: "f", label: "atlas-api", path: "/x/atlas-api" }] });
  assert.equal(p.length, 3);
  assert.ok(p.every((s) => s.text.includes("atlas-api")));
});
