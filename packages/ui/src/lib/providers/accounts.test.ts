import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@octo/agent-client";
import { accountBase, accountSlug, accountsOf, suggestedAccountDir, takesAccounts } from "./accounts";

const entry = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  kind: "agent",
  label: id,
  state: "ready",
  reason: "",
  install_hint: "",
  login_hint: "",
  models: [],
  default_model: "",
  flat_rate: true,
  ...extra,
});

test("accounts follow their agent and point back at it", () => {
  const claude = entry("claude-code", { account_env: "CLAUDE_CONFIG_DIR", account_default: "~/.claude" });
  const work = entry("claude-code@work", { account_of: "claude-code", account_id: "work" });
  const list = [claude, work, entry("codex", { account_env: "CODEX_HOME" }), entry("grok")];
  assert.deepEqual(
    accountsOf(list, "claude-code").map((p) => p.id),
    ["claude-code@work"],
  );
  assert.equal(accountBase(list, work)?.id, "claude-code");
  assert.equal(accountBase(list, claude), undefined);
  assert.equal(takesAccounts(claude), true);
  assert.equal(takesAccounts(work), false);
  assert.equal(takesAccounts(entry("grok")), false);
});

test("the suggested folder sits beside the agent's default one", () => {
  assert.equal(suggestedAccountDir({ id: "claude-code", account_default: "~/.claude" }, "Work"), "~/.claude-work");
  assert.equal(suggestedAccountDir({ id: "codex", account_default: "~/.codex/" }, "My Personal (2)"), "~/.codex-my-personal-2");
  assert.equal(suggestedAccountDir({ id: "omp" }, ""), "~/.omp-account");
});

test("the slug matches the harness's", () => {
  assert.equal(accountSlug("  My Personal (2) "), "my-personal-2");
  assert.equal(accountSlug("Работа"), "account");
  assert.equal(accountSlug("ab".repeat(40)), "ab".repeat(16));
});
