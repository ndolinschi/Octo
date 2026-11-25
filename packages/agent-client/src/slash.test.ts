import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState } from "./state";
import type { BridgeEvent } from "./types";

type Call = { url: string; method: string | undefined; body: string | undefined };

function bridgeWith(status: number, body: string) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

test("B11: the new events are subscribed to and leave the state alone", () => {
  for (const t of ["slash_commands.updated", "conversation.cleared", "fact.remembered", "fact.forgotten"]) {
    assert.ok(BRIDGE_EVENT_TYPES.includes(t as never), t);
  }
  const s = emptyProjectState();
  const events: BridgeEvent[] = [
    { type: "slash_commands.updated", seq: 1, project_id: "p" },
    {
      type: "conversation.cleared",
      seq: 2,
      project_id: "p",
      conversation_id: "conv_1",
      upto_message_id: 8,
      at: "t",
      title: "first request",
      summary: "s",
      summary_source: "stored",
    },
    {
      type: "fact.remembered",
      seq: 3,
      task_id: "tsk_1",
      fact: { id: "f1", text: "x", date: "d", message_id: 1, kind: "fact", remembered_by: "agt_1" },
      turn_id: 1,
      agent_id: "agt_1",
    },
    { type: "fact.forgotten", seq: 4, task_id: "tsk_1", fact_id: "f1" },
  ];
  for (const e of events) assert.deepEqual({ ...applyEvent(s, e), lastSeq: s.lastSeq }, s, e.type);
});

test("B11: request shapes", async () => {
  const slash = bridgeWith(
    200,
    '{"octo":[{"name":"clear","description":"d","available":true,"endpoint":"POST /v1/projects/{id}/clear"},{"name":"compact","description":"d","available":false,"reason":"r","endpoint":"e"}],' +
      '"agent":{"id":"claude","label":"Claude","pending":true,"commands":[]}}',
  );
  const got = await slash.bridge.getSlashCommands?.("p");
  assert.equal(slash.calls[0]?.method, "GET");
  assert.equal(slash.calls[0]?.url, "http://h:1/v1/projects/p/slash-commands");
  assert.equal(got?.octo[1]?.reason, "r");
  assert.equal(got?.agent?.pending, true);

  const clear = bridgeWith(200, '{"conversation_id":"c1","upto_message_id":4,"at":"t","title":"T","summary":"S","summary_source":"model"}');
  assert.deepEqual(await clear.bridge.clearConversation?.("p"), {
    conversation_id: "c1",
    upto_message_id: 4,
    at: "t",
    title: "T",
    summary: "S",
    summary_source: "model",
  });
  assert.equal(clear.calls[0]?.method, "POST");
  assert.equal(clear.calls[0]?.url, "http://h:1/v1/projects/p/clear");

  const busy = bridgeWith(409, '{"error":{"code":"turn_in_progress","message":"m"}}').bridge;
  await assert.rejects(
    busy.clearConversation?.("p") ?? Promise.reject(new Error("missing")),
    (e: unknown) => e instanceof BridgeError && e.code === "turn_in_progress",
  );

  const sent = bridgeWith(202, '{"sent_to_agent":true,"message":{"id":5,"command":"compact"}}');
  assert.deepEqual(await sent.bridge.compactNow?.("p"), { sent_to_agent: true, message: { id: 5, command: "compact" } });

  const remember = bridgeWith(201, '{"task_id":"tsk_1","fact":{"id":"f1","text":"x","date":"d","message_id":0}}');
  await remember.bridge.rememberFact?.("p", { text: "x", kind: "todo" });
  assert.equal(remember.calls[0]?.url, "http://h:1/v1/projects/p/facts");
  assert.deepEqual(JSON.parse(remember.calls[0]?.body ?? "null"), { text: "x", kind: "todo" });

  const forget = bridgeWith(204, "");
  await forget.bridge.forgetFact?.("p", "tsk 1", "f1");
  assert.equal(forget.calls[0]?.method, "DELETE");
  assert.equal(forget.calls[0]?.url, "http://h:1/v1/projects/p/facts/tsk%201/f1");
});

test("B11: the transcript carries the new-session markers and a command on a message", async () => {
  const { bridge } = bridgeWith(
    200,
    '{"messages":[{"id":1,"agent_id":"a","role":"user","content":[{"type":"text","text":"/init"}],"created_at":"t","command":"init"}],' +
      '"compactions":[],"conversations":[{"conversation_id":"c1","upto_message_id":1,"at":"t","label":"New session \\u00b7 earlier: x","title":"x","summary":"s","summary_source":"agent"}]}',
  );
  const tr = await bridge.getTranscript("p", "a");
  assert.equal(tr.messages[0]?.command, "init");
  assert.equal(tr.conversations?.[0]?.summary_source, "agent");
  const older = await bridgeWith(200, '{"messages":[],"compactions":[]}').bridge.getTranscript("p", "a");
  assert.equal(older.conversations, undefined);
});
