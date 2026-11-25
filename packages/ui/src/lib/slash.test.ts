import assert from "node:assert/strict";
import test from "node:test";
import type { SlashCommands } from "@octo/agent-client";
import { argsOptional, disabledSlashCommands, OCTO_COMMAND_NAMES, slashQuery } from "./slash";
import { NEW_COMMAND, OCTO_FALLBACK, octoCommandFor, parseSlash } from "./slashCommands";
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

test("Enter runs a command whose argument is optional; a required one is completed", () => {
  const row = (name: string, args?: string, group: "octo" | "agent" = "octo") => ({ group, name, args });
  assert.equal(argsOptional(row(NEW_COMMAND.name, "text")), true);
  assert.equal(argsOptional(row("model", "<name>")), true);
  assert.equal(argsOptional(row("review", "[pr]")), true);
  assert.equal(argsOptional(row("mode", "ask|plan|agent")), false);
  assert.equal(argsOptional(row("remember", "<text>")), false);
  assert.equal(argsOptional(row("compact")), false);
  assert.equal(argsOptional(row("review", "[pr]", "agent")), false);
});

test("disabledSlashCommands omits /memory and /review when their UI tab flags are false while preserving /remember", () => {
  const defaultDisabled = disabledSlashCommands({ memory: false, review: true });
  assert.equal(defaultDisabled.has("memory"), true);
  assert.equal(defaultDisabled.has("review"), false);
  assert.equal(
    slashGroups(null, "", defaultDisabled).rows.some((r) => r.name === "memory"),
    false,
  );
  assert.equal(octoCommandFor("/memory", null, defaultDisabled), null);

  const bothDisabled = disabledSlashCommands({ memory: false, review: false });
  const cmds: SlashCommands = {
    octo: [
      { name: "memory", description: "Memory", available: true, endpoint: "ui:memory" },
      { name: "remember", description: "Remember", args: "<text>", available: true, endpoint: "POST remember" },
      { name: "review", description: "Review", available: true, endpoint: "ui:review" },
    ],
    agent: null,
  };
  assert.deepEqual(
    slashGroups(cmds, "", bothDisabled).rows.map((r) => r.name),
    ["remember", "new", "btw"],
  );
  assert.equal(octoCommandFor("/remember use pnpm", cmds, bothDisabled)?.command.name, "remember");
  assert.equal(octoCommandFor("/review", cmds, bothDisabled), null);

  const sideDisabled = disabledSlashCommands({ memory: true, review: true, side: false });
  assert.equal(sideDisabled.has("btw"), true);
  assert.equal(octoCommandFor("/btw what does this do?", cmds, sideDisabled), null);
});

test("/btw is an Octo command that works without harness listing and accepts optional question text", () => {
  assert.equal(octoCommandFor("/btw what is retryDelay?", null)?.command.name, "btw");
  assert.equal(octoCommandFor("/btw what is retryDelay?", null)?.args, "what is retryDelay?");
  assert.equal(octoCommandFor("/btw", null)?.args, "");
  assert.equal(argsOptional({ group: "octo", name: "btw", args: "[question]" }), true);
});
