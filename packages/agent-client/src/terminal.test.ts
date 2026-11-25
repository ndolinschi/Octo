import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type EventSourceLike } from "./client";
import { decodeBase64 } from "./terminalSession";

type Call = { method: string | undefined; url: string; body: unknown; auth: string | undefined };

class FakeEventSource implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }

  close(): void {
    this.closed = true;
  }
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

test("openTerminal opens a PTY session, decodes base64 output, sends input/resize, and handles exit & close", async () => {
  const calls: Call[] = [];
  const streams: FakeEventSource[] = [];

  const bridge = createHttpBridge({
    baseUrl: "http://127.0.0.1:8790",
    token: "tok_abc",
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    },
    fetch: async (url, init) => {
      calls.push({
        method: init?.method,
        url,
        body: init?.body ? JSON.parse(init.body) : undefined,
        auth: init?.headers?.Authorization,
      });
      if (url.endsWith("/terminals") && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              session_id: "tm_001",
              folder: "app",
              cwd: "/workspace/app",
              shell: "bash",
              pid: 4242,
            }),
        };
      }
      if (url.endsWith("/input")) return { ok: true, status: 202, text: async () => "" };
      if (url.endsWith("/resize")) return { ok: true, status: 204, text: async () => "" };
      if (url.endsWith("/tm_001") && init?.method === "DELETE") return { ok: true, status: 204, text: async () => "" };
      return { ok: false, status: 404, text: async () => '{"error":{"code":"not_found","message":"not found"}}' };
    },
  });

  assert.ok(bridge.openTerminal);
  const term = await bridge.openTerminal("proj_1", { folder: "app", cols: 100, rows: 32 });
  assert.equal(term.sessionId, "tm_001");
  assert.equal(term.folder, "app");
  assert.equal(term.shell, "bash");
  assert.equal(term.pid, 4242);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.url, "http://127.0.0.1:8790/v1/projects/proj_1/terminals/tm_001/events?token=tok_abc");

  // Emit buffered output BEFORE listener attaches ("aGVsbG8g" === "hello ").
  streams[0]?.emit("output", JSON.stringify({ data: "aGVsbG8g" }));

  const received: string[] = [];
  term.onOutput((bytes) => {
    received.push(ascii(bytes));
  });
  assert.deepEqual(received, ["hello "]);

  // Live output after listener attaches ("d29ybGQNCg==" === "world\r\n").
  streams[0]?.emit("output", JSON.stringify({ data: "d29ybGQNCg==" }));
  assert.equal(received.join(""), "hello world\r\n");

  await term.write("ls -la\n");
  await term.resize(120, 40);
  assert.deepEqual(calls.find((c) => c.url.endsWith("/input"))?.body, { data: "ls -la\n" });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/resize"))?.body, { cols: 120, rows: 40 });

  const exits: { code: number; reason?: string }[] = [];
  term.onExit((info) => exits.push(info));
  streams[0]?.emit("exit", JSON.stringify({ code: 0 }));
  assert.deepEqual(exits, [{ code: 0 }]);
  assert.equal(streams[0]?.closed, true);

  await assert.rejects(term.write("after exit"), (e) => e instanceof BridgeError);
  await term.close();
  assert.equal(
    calls.some((c) => c.method === "DELETE" && c.url.endsWith("/tm_001")),
    true,
  );
});

test("decodeBase64 decodes unpadded and padded base64 bytes", () => {
  assert.equal(ascii(decodeBase64("T2N0bw==")), "Octo");
  assert.equal(ascii(decodeBase64("T2N0bw")), "Octo");
});
