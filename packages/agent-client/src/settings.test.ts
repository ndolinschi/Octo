import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type FetchLike } from "./client";
import { BRIDGE_METHODS } from "./messageProtocol";
import { applyEvent, emptyProjectState } from "./state";
import type { Setting, SettingsUpdate, SettingsView } from "./types";
import { SETTING_IDS } from "./types";

type Seen = { method: string | undefined; url: string; body: unknown };

/**
 * A stub of the harness's /v1/settings: it keeps the values, answers like the
 * server does (400 with an error envelope, never a secret in a response) and
 * records every request.
 */
function settingsServer(seen: Seen[]): FetchLike {
  const values = new Map<string, string | boolean | string[]>();
  const known = new Set<string>(Object.values(SETTING_IDS));
  const view = (): SettingsView => ({
    settings: [...known].map((id): Setting =>
      id === SETTING_IDS.anthropicApiKey
        ? {
            id,
            kind: "secret",
            label: "key",
            group: "keys",
            set: values.has(id),
            source: values.has(id) ? "file" : "default",
            applies: "restart",
            editable: true,
            ...(values.has(id) ? { hint: "…wxyz" } : {}),
          }
        : {
            id,
            kind: "text",
            label: id,
            group: "advanced",
            ...(values.has(id) ? { value: values.get(id) as string } : {}),
            set: values.has(id),
            source: values.has(id) ? "file" : "default",
            applies: "now",
            editable: true,
          },
    ),
    restart_required: values.has(SETTING_IDS.anthropicApiKey) ? [SETTING_IDS.anthropicApiKey] : [],
  });
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    seen.push({ method: init?.method, url, body });
    if (!url.endsWith("/v1/settings")) return reply(404, { error: { code: "not_found", message: "no such route" } });
    if (init?.method === "GET") return reply(200, view());
    const update = body as SettingsUpdate;
    for (const id of [...Object.keys(update.set ?? {}), ...(update.unset ?? [])]) {
      if (!known.has(id)) return reply(400, { error: { code: "unknown_setting", message: `unknown setting "${id}"` } });
    }
    for (const [id, v] of Object.entries(update.set ?? {})) values.set(id, v);
    for (const id of update.unset ?? []) values.delete(id);
    return reply(200, view());
  };
}

test("getSettings and putSettings call /v1/settings and return the view", async () => {
  const seen: Seen[] = [];
  const bridge = createHttpBridge({ baseUrl: "http://h:1/", fetch: settingsServer(seen) });

  const first = await bridge.getSettings();
  assert.equal(first.settings.length, Object.values(SETTING_IDS).length);
  assert.deepEqual(first.restart_required, []);

  const next = await bridge.putSettings({
    set: { [SETTING_IDS.anthropicApiKey]: "sk-secret", [SETTING_IDS.modelFast]: "m" },
    unset: [SETTING_IDS.routerBaseUrl],
  });
  assert.deepEqual(next.restart_required, [SETTING_IDS.anthropicApiKey]);
  const key = next.settings.find((s) => s.id === SETTING_IDS.anthropicApiKey);
  assert.equal(key?.set, true);
  assert.equal(key?.value, undefined);
  assert.equal(JSON.stringify(next).includes("sk-secret"), false);
  assert.equal(next.settings.find((s) => s.id === SETTING_IDS.modelFast)?.value, "m");

  assert.deepEqual(
    seen.map((s) => [s.method, s.url]),
    [
      ["GET", "http://h:1/v1/settings"],
      ["PUT", "http://h:1/v1/settings"],
    ],
  );
  assert.deepEqual(seen[1]?.body, { set: { ANTHROPIC_API_KEY: "sk-secret", HARNESS_MODEL_FAST: "m" }, unset: ["OCTO_ROUTER_BASE_URL"] });
  assert.equal(seen[0]?.body, undefined);
});

test("a refused update surfaces the server's error as a BridgeError", async () => {
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch: settingsServer([]) });
  await assert.rejects(bridge.putSettings({ set: { NOPE: "x" } }), (err) => err instanceof BridgeError && err.status === 400 && err.code === "unknown_setting");
});

test("a 403 (remote bind or foreign origin) is a BridgeError with its code", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":{"code":"forbidden","message":"settings are available to loopback clients only"}}',
  });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  await assert.rejects(bridge.getSettings(), (err) => err instanceof BridgeError && err.status === 403 && err.code === "forbidden");
});

test("settings.changed is subscribed to, advances the reducer and is not a message-bridge method", () => {
  assert.ok(BRIDGE_EVENT_TYPES.includes("settings.changed"));
  assert.equal((BRIDGE_METHODS as readonly string[]).includes("getSettings"), false);
  assert.equal((BRIDGE_METHODS as readonly string[]).includes("putSettings"), false);
  const before = emptyProjectState();
  const after = applyEvent(before, { type: "settings.changed", seq: 7, ids: [SETTING_IDS.modelFast] });
  assert.equal(after.lastSeq, 7);
  assert.deepEqual(after.agents, before.agents);
});
