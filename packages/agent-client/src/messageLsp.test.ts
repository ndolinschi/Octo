import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, type Bridge } from "./client";
import { createMessageClient, isClientMessage, isHostMessage, serveBridge, type MessagePortLike } from "./messageBridge";
import { createLspChannel } from "./lspChannel";
import type { LanguageServerExit, LanguageServerSession } from "./types";

type Listener = (msg: unknown) => void;

function portPair(): { a: MessagePortLike; b: MessagePortLike } {
  const la = new Set<Listener>();
  const lb = new Set<Listener>();
  const mk = (out: Set<Listener>, inn: Set<Listener>): MessagePortLike => ({
    postMessage(msg) {
      const copy = JSON.parse(JSON.stringify(msg)) as unknown;
      void Promise.resolve().then(() => out.forEach((cb) => cb(copy)));
    },
    onMessage(cb) {
      inn.add(cb);
      return () => void inn.delete(cb);
    },
  });
  return { a: mk(lb, la), b: mk(la, lb) };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

type Fake = { sent: unknown[]; closed: number; channel: ReturnType<typeof createLspChannel>; session: LanguageServerSession };

function setup() {
  const fakes: Fake[] = [];
  const opened: [string, string][] = [];
  const bridge = {
    listPlugins: async () => [{ name: "go-tools" }],
    listLanguageServers: async () => [],
    openLanguageServer: async (projectId: string, serverId: string) => {
      opened.push([projectId, serverId]);
      if (serverId === "missing") throw new BridgeError(404, "not_found", "unavailable");
      const channel = createLspChannel();
      const fake = { sent: [] as unknown[], closed: 0, channel } as Fake;
      fake.session = {
        rootUri: "file:///w",
        workspaceFolders: [{ uri: "file:///w", name: "w" }],
        send: async (m) => void fake.sent.push(m),
        onMessage: channel.onMessage,
        onExit: channel.onExit,
        close: async () => void fake.closed++,
      };
      fakes.push(fake);
      return fake.session;
    },
    subscribe: () => () => undefined,
  } as unknown as Bridge;
  const { a, b } = portPair();
  const server = serveBridge(b, bridge);
  const client = createMessageClient(a);
  return { client, server, fakes, opened };
}

test("listPlugins round-trips", async () => {
  const { client } = setup();
  assert.deepEqual(await client.bridge.listPlugins(), [{ name: "go-tools" }]);
});

test("full LSP session: open, both directions, exit, close", async () => {
  const { client, fakes, opened } = setup();
  const session = await client.bridge.openLanguageServer("p", "gopls");
  assert.deepEqual(opened, [["p", "gopls"]]);
  assert.equal(session.rootUri, "file:///w");
  assert.deepEqual(session.workspaceFolders, [{ uri: "file:///w", name: "w" }]);

  const fake = fakes[0];
  assert.ok(fake);
  fake.channel.push({ early: true });
  await tick();
  const got: unknown[] = [];
  session.onMessage((m) => got.push(m));
  assert.deepEqual(got, [{ early: true }]);

  fake.channel.push({ id: 1 });
  await tick();
  assert.deepEqual(got, [{ early: true }, { id: 1 }]);

  await session.send({ method: "initialize" });
  await tick();
  assert.deepEqual(fake.sent, [{ method: "initialize" }]);

  const exits: LanguageServerExit[] = [];
  session.onExit((i) => exits.push(i));
  fake.channel.exit({ code: 1, reason: "boom" });
  await tick();
  assert.deepEqual(exits, [{ code: 1, reason: "boom" }]);

  await session.close();
  await session.close();
  await tick();
  assert.equal(fake.closed, 0);
});

test("close reaches the real session once", async () => {
  const { client, fakes } = setup();
  const session = await client.bridge.openLanguageServer("p", "gopls");
  await session.close();
  await session.close();
  await tick();
  const [fake] = fakes;
  assert.ok(fake);
  assert.equal(fake.closed, 1);
  const got: unknown[] = [];
  session.onMessage((m) => got.push(m));
  fake.channel.push({ late: 1 });
  await tick();
  assert.deepEqual(got, []);
});

test("open failure rejects with BridgeError", async () => {
  const { client } = setup();
  await assert.rejects(
    client.bridge.openLanguageServer("p", "missing"),
    (e: unknown) => e instanceof BridgeError && e.status === 404 && e.code === "not_found",
  );
});

test("host dispose closes every session", async () => {
  const { client, server, fakes } = setup();
  await client.bridge.openLanguageServer("p", "a");
  await client.bridge.openLanguageServer("p", "b");
  server.dispose();
  await tick();
  assert.deepEqual(
    fakes.map((f) => f.closed),
    [1, 1],
  );
});

test("client dispose rejects a pending open", async () => {
  const { client } = setup();
  const pending = client.bridge.openLanguageServer("p", "gopls");
  client.dispose();
  await assert.rejects(pending, (e: unknown) => e instanceof BridgeError && e.code === "disposed");
});

test("lsp guards are strict", () => {
  assert.ok(isClientMessage({ kind: "lsp-open", id: 1, projectId: "p", serverId: "s" }));
  assert.ok(isClientMessage({ kind: "lsp-send", session: 1, message: null }));
  assert.ok(isClientMessage({ kind: "lsp-close", session: 1 }));
  assert.ok(!isClientMessage({ kind: "lsp-open", id: 1, projectId: "p" }));
  assert.ok(!isClientMessage({ kind: "lsp-send", session: 1 }));
  assert.ok(!isClientMessage({ kind: "lsp-close", session: "1" }));
  const folders = [{ uri: "u", name: "n" }];
  assert.ok(isHostMessage({ kind: "lsp-opened", id: 1, ok: true, session: 2, rootUri: "u", workspaceFolders: folders }));
  assert.ok(isHostMessage({ kind: "lsp-opened", id: 1, ok: false, error: { status: 1, code: "c", message: "m" } }));
  assert.ok(!isHostMessage({ kind: "lsp-opened", id: 1, ok: true, session: 2, rootUri: "u", workspaceFolders: [{ uri: 1 }] }));
  assert.ok(!isHostMessage({ kind: "lsp-opened", id: 1, ok: false, error: {} }));
  assert.ok(isHostMessage({ kind: "lsp-message", session: 1, message: {} }));
  assert.ok(!isHostMessage({ kind: "lsp-message", message: {} }));
  assert.ok(isHostMessage({ kind: "lsp-exit", session: 1, code: 0 }));
  assert.ok(isHostMessage({ kind: "lsp-exit", session: 1, code: 0, reason: "r" }));
  assert.ok(!isHostMessage({ kind: "lsp-exit", session: 1, code: "0" }));
  assert.ok(!isHostMessage({ kind: "lsp-exit", session: 1, code: 0, reason: 5 }));
});
