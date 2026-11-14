import assert from "node:assert/strict";
import test from "node:test";
import { agentLabelOf, allPlainStrings, commandOf, JARGON, plainError, stripJargon } from "./plain";

const RAW = [
  "ACP agent GitHub Copilot could not start: not logged in (exit status 1). Run `copilot login` in a terminal, then reopen this list.",
  "ACP agent Claude Code refused the harness's MCP server (method not supported); this request ran without harness tools (spawn_agent, notes).",
  "JSON-RPC error -32601: session/new not found",
  "agent exited with status 2: stderr: panic in session/prompt",
  "unexpected tool call spawn_agent failed",
  "rate limit exceeded (429)",
  "request timed out after 120s",
  "something odd happened. second sentence.",
  "mcp__harness__read_file failed with EPIPE",
  "",
];

test("no produced string contains protocol vocabulary", () => {
  for (const s of allPlainStrings()) assert.doesNotMatch(s, JARGON, s);
  for (const raw of RAW) {
    for (const agent of [undefined, "Claude Code"]) {
      const p = plainError(raw, { agent });
      assert.doesNotMatch(p.sentence, JARGON, `${raw} -> ${p.sentence}`);
      assert.match(p.sentence, /[.!?]$/);
      if (p.next?.kind === "command") assert.ok(p.next.command.length > 0);
    }
  }
});

test("a login failure names the agent and offers the command from the hint", () => {
  const p = plainError(RAW[0] ?? "", { agent: "GitHub Copilot", hint: "Run `copilot login` in a terminal." });
  assert.equal(p.sentence, "GitHub Copilot is not logged in.");
  assert.deepEqual(p.next, { kind: "command", command: "copilot login" });
  assert.match(p.details, /exit status 1/);
});

test("without a command the next step is to check again", () => {
  assert.deepEqual(plainError("not logged in", { agent: "Codex" }).next, { kind: "check" });
});

test("the harness-tools notice is plain and has no next step", () => {
  const p = plainError(RAW[1] ?? "", { agent: "Claude Code" });
  assert.match(p.sentence, /Claude Code ran this request without Octo's own tools/);
  assert.equal(p.next, null);
});

test("typed codes win over the text", () => {
  assert.match(plainError("whatever", { code: "images_unsupported", agent: "Haiku" }).sentence, /can't read images/);
});

test("unknown text falls back to its first sentence, stripped", () => {
  assert.equal(plainError("something odd happened. second sentence.").sentence, "Something odd happened.");
  assert.equal(stripJargon("ACP agent hung up (exit status 3). More."), "Agent hung up.");
});

test("agent labels and commands", () => {
  assert.equal(agentLabelOf("claude-code"), "Claude Code");
  assert.equal(agentLabelOf("my-agent"), "My Agent");
  assert.equal(commandOf("Run `copilot login` first"), "copilot login");
  assert.equal(commandOf(null), null);
});

test("a bare 401 in free text is not the provider key; a key refusal is, with the settings action", () => {
  const hook = plainError("Staging rejected the webhook signing secret (401). Rotate STAGING_WEBHOOK_SECRET, then ask again.");
  assert.doesNotMatch(hook.sentence, /key|Settings/);
  assert.match(hook.sentence, /Staging rejected the webhook signing secret/);
  assert.equal(hook.action, undefined);
  const key = plainError("invalid x-api-key");
  assert.equal(key.sentence, "The provider did not accept the key. Check it in Settings.");
  assert.equal(key.action, "open_settings");
  assert.equal(plainError("whatever", { code: "unauthorized" }).action, "open_settings");
});

test("a refused call's note has no code fences or backticks", () => {
  const p = plainError("```\nspawn_agent refused: tier `deep` is not allowed here\n```");
  assert.ok(!p.sentence.includes("`"), p.sentence);
  assert.ok(p.details.includes("```"));
});

test("P2-6: a body over the bridge's limit says the message is too long, with the limit", () => {
  const want = "This message is too long to send (limit 1 MB). Send less at a time.";
  assert.equal(plainError("request body over 1048576 bytes", { code: "request_too_large" }).sentence, want);
  assert.equal(plainError("http: request body too large").sentence, want);
  assert.equal(plainError("http: request body too large").next, null);
});

test("NEW-1: a failure with no text says the request failed and offers Retry, never 'no reason'", () => {
  for (const raw of ["", "   ", null, undefined]) {
    const p = plainError(raw);
    assert.equal(p.sentence, "This request failed.");
    assert.deepEqual(p.next, { kind: "retry" });
    assert.doesNotMatch(p.sentence, /no reason/i);
  }
});
