import assert from "node:assert/strict";
import test from "node:test";
import { favouritesFrom, modelChoices, toggleFavourite, withFavourites } from "./modelPicker";

const acp = [
  {
    value: "acp:claude-code" as const,
    id: "claude-code",
    label: "Claude Code",
    models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    default_model: "claude-sonnet-5-5",
  },
  { value: "acp:copilot" as const, id: "copilot", label: "Copilot", models: [] },
];

test("modelChoices: tiers with their models, known models once, agents and their models", () => {
  const c = modelChoices({
    tiers: { fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
    known: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "acp:claude-code", ""],
    acp,
    agents: [{ id: "copilot", available: true, logged_in: false, hint: "Run `copilot login`." }],
  });
  assert.deepEqual(
    c.filter((x) => x.section === "Tiers").map((x) => [x.label, x.detail]),
    [
      ["Balanced", "Sonnet 5.5"],
      ["Fast", "Haiku 5.5"],
      ["Deep", "Opus 5.5"],
    ],
  );
  assert.deepEqual(
    c.filter((x) => x.section === "Models").map((x) => x.value),
    ["claude-opus-5-5", "claude-sonnet-5-5"],
  );
  const agents = c.filter((x) => x.section === "Agents");
  assert.deepEqual(
    agents.map((x) => x.value),
    ["acp:claude-code", "acp:claude-code/claude-opus-5-5", "acp:copilot"],
  );
  assert.equal(agents[1]?.label, "Claude Code · Opus 5.5");
  assert.equal(agents[2]?.disabled, true);
  assert.equal(agents[2]?.hint, "logged out");
  assert.match(agents[2]?.title ?? "", /copilot login/);
});

test("modelChoices without tiers lists no tier rows", () => {
  assert.equal(
    modelChoices({ known: ["claude-opus-5-5"], acp: [], agents: [] }).some((c) => c.section === "Tiers"),
    false,
  );
});

test("favourites", () => {
  const c = modelChoices({ known: ["claude-opus-5-5", "claude-haiku-5-5"], acp, agents: [] });
  const { favourites } = withFavourites(c, ["claude-haiku-5-5", "gone", "acp:claude-code"]);
  assert.deepEqual(
    favourites.map((f) => f.value),
    ["claude-haiku-5-5", "acp:claude-code"],
  );
  assert.deepEqual(toggleFavourite(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleFavourite(["a", "b"], "a"), ["b"]);
  assert.deepEqual(favouritesFrom(["a", 1, "", null, "b"]), ["a", "b"]);
  assert.deepEqual(favouritesFrom({}), []);
});
