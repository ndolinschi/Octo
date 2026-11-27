import assert from "node:assert/strict";
import test from "node:test";
import type { AgentLoginState, Provider } from "@octo/agent-client";
import { demoProviders } from "./providers";

const listOf = async (bridge: ReturnType<typeof demoProviders>): Promise<Provider[]> => (await bridge.listProviders()).providers;
/** `assert.rejects` check: an error whose message matches. */
const said = (re: RegExp) => (e: unknown) => e instanceof Error && re.test(e.message);
const ids = (list: readonly Provider[]) => list.filter((p) => p.kind === "agent").map((p) => p.id);

test("no accounts knob: agents with accounts take them, the others say why not, labels stay plain", async () => {
  const list = await listOf(demoProviders({ accounts: null, limit: null }));
  const claude = list.find((p) => p.id === "claude-code");
  assert.equal(claude?.label, "Claude Code");
  assert.equal(claude?.account_env, "CLAUDE_CONFIG_DIR");
  assert.equal(claude?.account_unsupported, undefined);
  assert.deepEqual(ids(list), ["claude-code", "codex", "copilot", "grok"]);
  const copilot = list.find((p) => p.id === "copilot");
  assert.ok(copilot?.account_unsupported);
  assert.ok((copilot.login_methods?.length ?? 0) > 0);
});

test("?accounts=all adds Codex · Second, logged out and owned, after Claude Code · Work", async () => {
  const list = await listOf(demoProviders({ accounts: "all", limit: null }));
  assert.deepEqual(ids(list).slice(0, 4), ["claude-code", "claude-code@work", "codex", "codex@second"]);
  const second = list.find((p) => p.id === "codex@second");
  assert.equal(second?.label, "Codex · Second");
  assert.equal(second?.state, "not_logged_in");
  assert.equal(second?.account_owned, true);
  assert.equal(second?.login_command, "CODEX_HOME=~/.codex-second codex login");
});

test("rename names an account or the agent's own login; the id stays", async () => {
  const demo = demoProviders({ accounts: "work", limit: null });
  const renamed = await demo.renameAgentAccount("claude-code@work", "Job");
  assert.equal(renamed?.id, "claude-code@work");
  assert.equal(renamed?.label, "Claude Code · Job");
  const def = await demo.renameAgentAccount("claude-code", "Personal");
  assert.equal(def?.label, "Claude Code · Personal");
  assert.equal(def?.account_default_label, "Personal");
  await assert.rejects(demo.renameAgentAccount("claude-code@nope", "X"), said(/no longer exists/));
  await assert.rejects(demo.renameAgentAccount("copilot", "X"), said(/more than one account/));
  await assert.rejects(demo.renameAgentAccount("claude-code", " "), said(/short name/));
});

test("remove deletes the folder only of an account Octo created", async () => {
  const demo = demoProviders({ accounts: "work", limit: null });
  await assert.rejects(demo.removeAgentAccount("claude-code", "work", { deleteFolder: true }), said(/did not create/));
  assert.ok((await listOf(demo)).some((p) => p.id === "claude-code@work"));
  await demo.addAgentAccount("claude-code", { label: "Blue", config_dir: "~/.claude-blue" });
  await demo.removeAgentAccount("claude-code", "blue", { deleteFolder: true });
  await demo.removeAgentAccount("claude-code", "work");
  assert.deepEqual(ids(await listOf(demo)).slice(0, 2), ["claude-code", "codex"]);
});

test("a demo login prints a link and a code, and turns ok after Enter", async () => {
  const demo = demoProviders({ accounts: "all", limit: null });
  const session = await demo.startAgentLogin("codex@second", { method: "device" });
  let text = "";
  session.onOutput((chunk) => (text += new TextDecoder().decode(chunk)));
  const states: AgentLoginState[] = [];
  let exited = false;
  session.onExit(() => (exited = true));
  session.onLogin((s) => states.push(s));
  assert.match(text, /https:\/\/auth\.openai\.com\/\S+/);
  assert.match(text, /one-time code: \S+/);
  assert.equal(session.command, "CODEX_HOME=~/.codex-second codex login");
  assert.deepEqual(states, []);
  await session.write("\r");
  assert.deepEqual(states, ["ok"]);
  assert.equal(exited, true);
  assert.equal((await listOf(demo)).find((p) => p.id === "codex@second")?.state, "ready");
  const late: AgentLoginState[] = [];
  session.onLogin((s) => late.push(s));
  assert.deepEqual(late, ["ok"]);
  await session.close();
});

test("a login for an entry the demo does not list is refused", async () => {
  const demo = demoProviders({ accounts: null, limit: null });
  await assert.rejects(demo.startAgentLogin("grok-unknown"), said(/no agent/));
  await assert.rejects(demo.startAgentLogin("claude-code@nope"), said(/no agent/));
});

test("?limit=<id> puts the limit on that account only, and says which orchestrator settings are limited", async () => {
  const demo = demoProviders({ accounts: "work", limit: "claude-code@work" });
  const list = await listOf(demo);
  assert.ok(list.find((p) => p.id === "claude-code@work")?.limit?.reached_at);
  assert.ok(Date.parse(list.find((p) => p.id === "claude-code@work")?.limit?.resets_at ?? "") > Date.now());
  assert.equal(list.find((p) => p.id === "claude-code")?.limit, undefined);
  assert.equal(demo.limited("acp:claude-code@work/opus")?.label, "Claude Code · Work");
  assert.equal(demo.limited("acp:claude-code/opus"), null);
  assert.equal(demo.limited("claude-sonnet-5-5"), null);
});
