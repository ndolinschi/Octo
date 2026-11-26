import assert from "node:assert/strict";
import test from "node:test";
import { commandsIn } from "./hints";

test("commandsIn: backtick commands, a bare npm install, or the hint itself when it is one command", () => {
  assert.deepEqual(commandsIn("Log in once: run `claude` and type /login (or run `claude auth login`)."), ["claude", "claude auth login"]);
  assert.deepEqual(commandsIn("Install Node.js and the Claude Code CLI: npm install -g @anthropic-ai/claude-code"), [
    "npm install -g @anthropic-ai/claude-code",
  ]);
  assert.deepEqual(commandsIn("Install the GitHub Copilot CLI: npm install -g @github/copilot (needs Node.js 22 or newer)"), [
    "npm install -g @github/copilot",
  ]);
  assert.deepEqual(commandsIn("Install it: `npm install -g @github/copilot`"), ["npm install -g @github/copilot"]);
  assert.deepEqual(commandsIn("claude auth login"), ["claude auth login"]);
  assert.deepEqual(commandsIn("grok login"), ["grok login"]);
});

test("commandsIn: prose without a command, variable names and empty hints give nothing", () => {
  assert.deepEqual(commandsIn("Install the Grok CLI so that it is on PATH (from x.ai)."), []);
  // A program named in prose ("so that `grok` is on PATH") is not a command to run.
  assert.deepEqual(commandsIn("Install the Grok CLI so that `grok` is on PATH (from x.ai)."), []);
  assert.deepEqual(commandsIn("Set `XAI_API_KEY` to bill per token."), []);
  assert.deepEqual(commandsIn(undefined), []);
  assert.deepEqual(commandsIn("   "), []);
  assert.deepEqual(commandsIn("run `grok login` or `grok login`"), ["grok login"]);
});

test("commandsIn: an agent account's login command keeps its variable in front", () => {
  assert.deepEqual(
    commandsIn("Log this account in once: run `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login` in a terminal. Its login stays in ~/.claude-work."),
    ["CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"],
  );
  assert.deepEqual(commandsIn("run `CODEX_HOME='/a b/codex' codex login`"), ["CODEX_HOME='/a b/codex' codex login"]);
  // A bare assignment is not a command.
  assert.deepEqual(commandsIn("Set `CLAUDE_CONFIG_DIR=~/.x` first."), []);
});
