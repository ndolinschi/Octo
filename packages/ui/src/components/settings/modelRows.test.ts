import type { Provider, ProviderList } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { runnableSwap } from "./modelRows";

const p = (id: string, kind: Provider["kind"], state: Provider["state"], models: string[] = []): Provider => ({
  id,
  kind,
  label: id === "claude-code" ? "Claude Code" : id,
  state,
  reason: "",
  install_hint: "",
  login_hint: "",
  models: models.map((m) => ({ id: m, label: m, source: "manifest" as const })),
  default_model: models[0] ?? "",
  flat_rate: kind === "agent",
});
const list = (providers: Provider[]): ProviderList => ({
  providers,
  connected: providers.filter((x) => x.state === "ready").length,
  suggested: { orchestrator: "", fast: "", balanced: "", deep: "" },
});

test("runnableSwap: the same model on a connected agent, else its default; null when it runs", () => {
  const l = list([
    p("api", "api", "not_connected", ["claude-sonnet-5-5"]),
    p("codex", "agent", "ready"),
    p("claude-code", "agent", "ready", ["claude-sonnet-5-5"]),
  ]);
  assert.equal(runnableSwap(l, "claude-sonnet-5-5"), "acp:claude-code/claude-sonnet-5-5");
  assert.equal(runnableSwap(l, "gpt-9"), "acp:claude-code");
  assert.equal(runnableSwap(l, "acp:codex"), null);
  assert.equal(runnableSwap(l, ""), null);
  assert.equal(runnableSwap(list([p("api", "api", "ready")]), "claude-sonnet-5-5"), null);
  assert.equal(runnableSwap(list([p("api", "api", "not_connected"), p("grok", "agent", "not_installed")]), "x"), null);
});
