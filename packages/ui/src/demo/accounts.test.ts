import assert from "node:assert/strict";
import test from "node:test";
import type { AgentLoginState, Provider } from "@octo/agent-client";
import { demoProviders } from "./providers";

const listOf = async (bridge: ReturnType<typeof demoProviders>): Promise<Provider[]> => (await bridge.listProviders()).providers;
/** `assert.rejects` check: an error whose message matches. */
const said = (re: RegExp) => (e: unknown) => e instanceof Error && re.test(e.message);
const ids = (list: readonly Provider[]) => list.filter((p) => p.kind === "agent").map((p) => p.id);

test("no accounts knob: every agent says whether it supports accounts, labels stay plain", async () => {
  const demo = demoProviders({ accounts: null, limit: null });
  const list = await listOf(demo);
  const claude = list.find((p) => p.id === "claude-code");
  assert.equal(claude?.label, "Claude Code");
  assert.equal(claude?.accounts_support?.supported, true);
  assert.equal(claude?.account?.default, true);
  assert.deepEqual(ids(list), ["claude-code", "codex", "copilot", "grok"]);
  // An agent that cannot have accounts says why and has no account block.
  const copilot = list.find((p) => p.id === "copilot");
  assert.ok(copilot);
  assert.equal(copilot.accounts_support?.supported, false);
  assert.ok(copilot.accounts_support?.reason);
  assert.equal(copilot.account, undefined);
  assert.ok((copilot.login_methods?.length ?? 0) > 0);
});

test("?accounts=claude adds Claude Code · Work, logged out, and names the default Personal", async () => {
  const demo = demoProviders({ accounts: "claude", limit: null });
  const list = await listOf(demo);
  assert.deepEqual(ids(list).slice(0, 3), ["claude-code", "claude-code@work", "codex"]);
  const base = list.find((p) => p.id === "claude-code");
  const work = list.find((p) => p.id === "claude-code@work");
  assert.equal(base?.label, "Claude Code · Personal");
  assert.equal(base?.account?.name, "Personal");
  assert.equal(work?.label, "Claude Code · Work");
  assert.equal(work?.state, "not_logged_in");
  assert.equal(work?.base_id, "claude-code");
  assert.equal(work?.accounts_support, undefined);
  assert.equal(list.find((p) => p.id === "codex")?.label, "Codex");
});

test("?accounts=all also adds Codex · Second, ready", async () => {
  const list = await listOf(demoProviders({ accounts: "all", limit: null }));
  const second = list.find((p) => p.id === "codex@second");
  assert.equal(second?.label, "Codex · Second");
  assert.equal(second?.state, "ready");
});

test("add makes a derived account, rename keeps the id, remove drops it", async () => {
  const demo = demoProviders({ accounts: null, limit: null });
  const added = await demo.addAgentAccount("claude-code", { name: "Team Blue" });
  assert.equal(added.account.id, "team-blue");
  assert.equal(added.account.owned, true);
  assert.equal(added.provider.id, "claude-code@team-blue");
  assert.equal(added.provider.state, "not_logged_in");
  // Two accounts now: the base label names its account too (the default is still "Default" until renamed).
  let list = await listOf(demo);
  assert.equal(list.find((p) => p.id === "claude-code")?.label, "Claude Code · Default");

  const renamedDefault = await demo.renameAgentAccount("claude-code", "Personal");
  assert.equal(renamedDefault.account.default, true);
  const renamed = await demo.renameAgentAccount("claude-code@team-blue", "Blue");
  assert.equal(renamed.provider.id, "claude-code@team-blue");
  assert.equal(renamed.provider.label, "Claude Code · Blue");
  list = await listOf(demo);
  assert.equal(list.find((p) => p.id === "claude-code")?.label, "Claude Code · Personal");

  // A name that gives the same slug gets a number; "Use an existing folder" is not owned.
  const again = await demo.addAgentAccount("claude-code", { name: "blue", dir: "/Users/me/.claude-blue" });
  assert.equal(again.account.id, "blue");
  assert.equal(again.account.owned, false);
  assert.equal((await demo.addAgentAccount("claude-code", { name: "Blue" })).account.id, "blue-2");

  await assert.rejects(demo.removeAgentAccount("claude-code", { deleteData: false }), said(/default account/));
  const gone = await demo.removeAgentAccount("claude-code@team-blue", { deleteData: true });
  assert.equal(gone.deleted_dir?.includes("team-blue"), true);
  const kept = await demo.removeAgentAccount("claude-code@blue", { deleteData: true });
  assert.equal(kept.deleted_dir, null);
  assert.equal(
    (await listOf(demo)).some((p) => p.id === "claude-code@team-blue"),
    false,
  );
});

test("an agent that cannot have accounts refuses one and an empty name is refused", async () => {
  const demo = demoProviders({ accounts: null, limit: null });
  await assert.rejects(demo.addAgentAccount("copilot", { name: "Work" }), said(/GitHub Copilot/));
  await assert.rejects(demo.addAgentAccount("claude-code", { name: "   " }), said(/name/));
  await assert.rejects(demo.addAgentAccount("nope", { name: "Work" }), said(/no agent/));
});

test("a demo login prints a link and a code, and turns ok after Enter", async () => {
  const demo = demoProviders({ accounts: "claude", limit: null });
  const session = await demo.startAgentLogin("claude-code@work", { method: "claudeai" });
  let text = "";
  session.onOutput((chunk) => (text += new TextDecoder().decode(chunk)));
  const states: AgentLoginState[] = [];
  let exited = false;
  session.onExit(() => (exited = true));
  session.onLogin((s) => states.push(s));
  assert.match(text, /https:\/\/claude\.ai\/\S+/);
  assert.match(text, /one-time code: \S+/);
  assert.match(session.command, /^CLAUDE_CONFIG_DIR="[^"]+work" claude auth login --claudeai$/);
  assert.deepEqual(states, []);
  await session.write("\r");
  assert.deepEqual(states, ["ok"]);
  assert.equal(exited, true);
  assert.equal((await listOf(demo)).find((p) => p.id === "claude-code@work")?.state, "ready");
  await session.close();
});

test("the session's command follows the chosen method, and the login state is emitted once per login", async () => {
  const demo = demoProviders({ accounts: "claude", limit: null });
  const session = await demo.startAgentLogin("claude-code@work", { method: "console" });
  assert.match(session.command, /claude auth login --console$/);
  const first: AgentLoginState[] = [];
  const second: AgentLoginState[] = [];
  session.onLogin((s) => first.push(s));
  await session.write("\r");
  await session.write("\r");
  session.onLogin((s) => second.push(s));
  assert.deepEqual(first, ["ok"]);
  assert.deepEqual(second, ["ok"]);
  await session.close();
  const plain = await demo.startAgentLogin("claude-code", {});
  assert.equal(plain.command, "claude auth login");
  await plain.close();
});

test("a login for an account the demo does not list is refused", async () => {
  const demo = demoProviders({ accounts: null, limit: null });
  await assert.rejects(demo.startAgentLogin("grok-unknown"), said(/no agent/));
  await assert.rejects(demo.startAgentLogin("claude-code@nope"), said(/no agent/));
});

test("?limit=<id> puts the limit on that account only, and says which orchestrator settings are limited", async () => {
  const demo = demoProviders({ accounts: "claude", limit: "claude-code@work" });
  const list = await listOf(demo);
  assert.ok(list.find((p) => p.id === "claude-code@work")?.limit?.reached_at);
  assert.ok(Date.parse(list.find((p) => p.id === "claude-code@work")?.limit?.resets_at ?? "") > Date.now());
  assert.equal(list.find((p) => p.id === "claude-code")?.limit, undefined);
  assert.equal(demo.limited("acp:claude-code@work/opus")?.label, "Claude Code · Work");
  assert.equal(demo.limited("acp:claude-code/opus"), null);
  assert.equal(demo.limited("claude-sonnet-5-5"), null);
});
