import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS_DETAIL, ACCESS_LABEL, ACCESS_MODES } from "./access";
import { MODE_LABEL } from "./modeLabels";

// The copy rule: one name per thing. "Ask" is the composer mode (Agent / Ask / Plan); a permission level must not reuse it.
test("permission levels never share a name with a composer mode", () => {
  const modes = new Set(Object.values(MODE_LABEL).map((l) => l.toLowerCase()));
  for (const m of ACCESS_MODES) assert.ok(!modes.has(ACCESS_LABEL[m].toLowerCase()), `permission level "${ACCESS_LABEL[m]}" is also a mode`);
});

test("permission levels: Ask first, Accept edits, Allow all, each with what it does", () => {
  assert.deepEqual(
    ACCESS_MODES.map((m) => ACCESS_LABEL[m]),
    ["Ask first", "Accept edits", "Allow all"],
  );
  assert.equal(ACCESS_DETAIL.supervised, "Asks before edits and commands");
});
