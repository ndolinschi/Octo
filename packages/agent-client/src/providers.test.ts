import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type FetchLike } from "./client";
import { BRIDGE_METHODS } from "./messageProtocol";
import { applyEvent, emptyProjectState } from "./state";
import type { ProvidersResponse } from "./types";

const sample: ProvidersResponse = {
  connected: 2,
  suggested: { orchestrator: "claude-sonnet-5-5", fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
  providers: [
    {
      id: "api",
      kind: "api",
      label: "Anthropic API",
      state: "ready",
      reason: "",
      install_hint: "",
      login_hint: "Add an API key in Settings (ANTHROPIC_API_KEY).",
      models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", source: "catalogue" }],
      default_model: "claude-sonnet-5-5",
      flat_rate: false,
    },
    {
      id: "claude-code",
      kind: "agent",
      label: "Claude Code",
      state: "not_logged_in",
      reason: "not logged in",
      install_hint: "",
      login_hint: "Run `claude` once.",
      models: [
        { id: "opus", label: "opus", source: "manifest", seen_at: "2026-11-11T12:00:00Z", stale: true },
        { id: "haiku", label: "haiku", source: "advertised", seen_at: "2026-11-11T12:00:00Z" },
      ],
      default_model: "opus",
      flat_rate: true,
    },
  ],
};

test("listProviders reads GET /v1/providers as is", async () => {
  const seen: { method: string | undefined; url: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ method: init?.method, url });
    return { ok: true, status: 200, text: async () => JSON.stringify(sample) };
  };
  const bridge = createHttpBridge({ baseUrl: "http://h:1/", fetch });
  const got = await bridge.listProviders();
  assert.deepEqual(got, sample);
  assert.deepEqual(seen, [{ method: "GET", url: "http://h:1/v1/providers" }]);
  // Typed access to the optional fields.
  assert.equal(got.providers[1]?.models[0]?.stale, true);
});

test("listProviders is HTTP-only: not a message-bridge method", () => {
  assert.equal((BRIDGE_METHODS as readonly string[]).includes("listProviders"), false);
});

test("model_unavailable keeps the provider and the reason on the error", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 422,
    text: async () =>
      JSON.stringify({
        error: { code: "model_unavailable", message: 'models.fast "acp:copilot" cannot run', provider: "copilot", reason: "Copilot is not logged in." },
      }),
  });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  await assert.rejects(
    bridge.createProject({ name: "p", models: { fast: "acp:copilot" } }),
    (err) =>
      err instanceof BridgeError &&
      err.status === 422 &&
      err.code === "model_unavailable" &&
      err.provider === "copilot" &&
      err.reason === "Copilot is not logged in.",
  );
  // An ordinary error carries neither.
  const plain = createHttpBridge({
    baseUrl: "http://h:1",
    fetch: async () => ({ ok: false, status: 409, text: async () => '{"error":{"code":"no_provider","message":"No provider is connected."}}' }),
  });
  await assert.rejects(plain.createProject({ name: "p" }), (err) => err instanceof BridgeError && err.code === "no_provider" && err.provider === undefined);
});

test("providers.updated is subscribed to and bumps providersRevision", () => {
  assert.ok(BRIDGE_EVENT_TYPES.includes("providers.updated"));
  const before = emptyProjectState();
  assert.equal(before.providersRevision, 0);
  const after = applyEvent(before, { type: "providers.updated", seq: 4, connected: 1 });
  assert.equal(after.providersRevision, 1);
  assert.equal(after.lastSeq, 4);
  assert.deepEqual(after.agents, before.agents);
});

test("project.attention carries the failed state until the next turn clears it; plain counts keep it", () => {
  let s = emptyProjectState();
  assert.equal(s.attention.state, undefined);
  s = applyEvent(s, { type: "project.attention", seq: 1, needs_you: false, approvals: 0, inputs: 0, state: "failed", error: "No API key" });
  assert.deepEqual(s.attention, { needs_you: false, approvals: 0, inputs: 0, state: "failed", error: "No API key" });
  // An approval count event without a state does not forget the failure.
  s = applyEvent(s, { type: "project.attention", seq: 2, needs_you: true, approvals: 1, inputs: 0 });
  assert.equal(s.attention.state, "failed");
  assert.equal(s.attention.error, "No API key");
  assert.equal(s.attention.needs_you, true);
  // A retry starts: none, and the error is gone.
  s = applyEvent(s, { type: "project.attention", seq: 3, needs_you: false, approvals: 0, inputs: 0, state: "none" });
  assert.deepEqual(s.attention, { needs_you: false, approvals: 0, inputs: 0, state: "none" });
});
