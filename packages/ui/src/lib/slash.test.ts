import assert from "node:assert/strict";
import test from "node:test";
import type { SlashCommands } from "@octo/agent-client";
import { OCTO_COMMAND_NAMES, OCTO_FALLBACK, octoCommandFor, parseSlash, slashQuery } from "./slash";
import { slashGroups } from "./slashRows";

const CMDS: SlashCommands = {
  octo: [
    { name: "compact", description: "Compact", available: true, endpoint: "POST x" },
    { name: "review", description: "Review", available: false, reason: "No repository", endpoint: "ui:review" },
    { name: "clear", description: "Clear", available: true, endpoint: "POST y" },
  ],
  agent: {
    id: "claude-code",
    label: "Claude Code",
    commands: [
      { name: "init", description: "Init" },
      { name: "cost", description: "Cost" },
    ],
  },
};

test("the menu opens only for a slash at the very start", () => {
  assert.equal(slashQuery("/co", 3), "co");
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("hi /co", 6), null);
  assert.equal(slashQuery("/compact now", 12), null);
  assert.equal(slashQuery("/src/lib", 8), null);
});

test("two groups, the agent's under its name, filtered", () => {
  const all = slashGroups(CMDS, "");
  assert.deepEqual(
    all.groups.map((g) => g.label),
    ["Octo", "Claude Code"],
  );
  const c = slashGroups(CMDS, "c");
  assert.ok(c.rows.every((r) => /c/i.test(r.name)));
  assert.equal(slashGroups(CMDS, "zzz").rows.length, 0);
});

test("fuzzy match finds a command from scattered letters; unavailable rows stay with their reason", () => {
  assert.equal(slashGroups(CMDS, "cmp").rows[0]?.name, "compact");
  const review = slashGroups(CMDS, "rev").rows.find((r) => r.name === "review");
  assert.equal(review?.available, false);
  assert.equal(review?.reason, "No repository");
});

test("no agent group without an agent, and a fallback list without the endpoint", () => {
  const g = slashGroups(null, "");
  assert.deepEqual(
    g.groups.map((x) => x.label),
    ["Octo"],
  );
  assert.ok(g.rows.some((r) => r.name === "settings"));
});

test("typed commands: Octo ones run, the agent's are sent as typed", () => {
  assert.deepEqual(parseSlash("/remember use pnpm"), { name: "remember", args: "use pnpm" });
  assert.equal(parseSlash("hello"), null);
  assert.equal(octoCommandFor("/compact", CMDS)?.command.name, "compact");
  assert.equal(octoCommandFor("/init", CMDS), null);
  assert.equal(octoCommandFor("/review", CMDS), null);
});

test("OCTO_COMMAND_NAMES covers every command the UI runs without a harness list", () => {
  for (const c of OCTO_FALLBACK) assert.ok(OCTO_COMMAND_NAMES.includes(c.name), c.name);
});

test("/new is an Octo command even when the harness does not list it, and takes the rest as its text", () => {
  assert.equal(octoCommandFor("/new Check the logs", null)?.command.name, "new");
  assert.equal(octoCommandFor("/new Check the logs", null)?.args, "Check the logs");
  const none: SlashCommands = { octo: [], agent: null };
  assert.equal(octoCommandFor("/new", none)?.args, "");
  assert.ok(OCTO_COMMAND_NAMES.includes("new"));
});
