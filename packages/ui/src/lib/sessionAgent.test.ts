import assert from "node:assert/strict";
import test from "node:test";
import { modelName } from "./models";
import { sessionAgentName } from "./sessionAgent";

test("sessionAgentName names the agent by its label, Octo's own loop by its model", () => {
  assert.equal(sessionAgentName("acp:claude-code/claude-opus-5-5"), "Claude Code");
  assert.equal(sessionAgentName("acp:copilot", [{ id: "copilot", label: "GitHub Copilot" }]), "GitHub Copilot");
  assert.equal(sessionAgentName("acp:my-agent"), "My Agent");
  assert.equal(sessionAgentName("claude-opus-5-5"), modelName("claude-opus-5-5"));
  assert.equal(sessionAgentName(""), null);
});
