import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTICE_DISCONNECTED,
  PairingError,
  TOKEN_KEY,
  claim,
  codeFromHash,
  deviceNameFromUA,
  formatCode,
  isDeviceGone,
  loadToken,
  saveToken,
  startPhase,
  type FetchFn,
  type StorageLike,
} from "./pairing";

function memoryStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a test double of a key-value store
      delete data[k];
    },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

function fakeFetch(answers: { status: number; body: unknown }[]): FetchFn & { calls: Call[] } {
  const calls: Call[] = [];
  const f: FetchFn = (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
    const a = answers.shift() ?? { status: 500, body: {} };
    return Promise.resolve({ ok: a.status < 300, status: a.status, json: () => Promise.resolve(a.body) });
  };
  return Object.assign(f, { calls });
}

const TOKEN = "octo_dev_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

test("the code of a QR link is read from the fragment only", () => {
  assert.equal(codeFromHash("#pair=abcd2345"), "ABCD-2345");
  assert.equal(codeFromHash("#x=1&pair=ABCD-2345"), "ABCD-2345");
  assert.equal(codeFromHash("#nothing"), null);
  assert.equal(codeFromHash(""), null);
  assert.equal(formatCode("ab cd-23 45"), "ABCD-2345");
});

test("a default device name comes from the user agent", () => {
  assert.equal(deviceNameFromUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"), "iPhone");
  assert.equal(deviceNameFromUA("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari"), "Android phone");
  assert.equal(deviceNameFromUA("curl/8"), "Browser");
});

test("only a device token is read back from storage", () => {
  const s = memoryStorage({ [TOKEN_KEY]: "something-else" });
  assert.equal(loadToken(s), null);
  saveToken(s, TOKEN);
  assert.equal(loadToken(s), TOKEN);
  const broken: StorageLike = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => undefined,
  };
  assert.equal(loadToken(broken), null);
  saveToken(broken, TOKEN); // does not throw
});

test("claim posts the code and the trimmed name", async () => {
  const f = fakeFetch([{ status: 201, body: { device_id: "dev_1", name: "iPhone", token: TOKEN, status: "pending" } }]);
  const c = await claim(f, "https://x.trycloudflare.com", "abcd2345", " iPhone ");
  assert.equal(c.token, TOKEN);
  assert.equal(f.calls[0]?.url, "https://x.trycloudflare.com/pair/claim");
  assert.deepEqual(JSON.parse(f.calls[0]?.body ?? "null"), { code: "ABCD-2345", name: "iPhone" });
});

test("a refused claim carries the harness's words", async () => {
  const f = fakeFetch([
    { status: 423, body: { error: { code: "pairing_locked", message: "Too many wrong codes were tried.", hint: "Ask the computer for a new code." } } },
  ]);
  try {
    await claim(f, "", "ABCD2345", "x");
    assert.ok(false, "no error");
  } catch (e) {
    assert.ok(e instanceof PairingError);
    if (e instanceof PairingError) {
      assert.equal(e.code, "pairing_locked");
      assert.equal(e.message, "Too many wrong codes were tried.");
      assert.equal(e.hint, "Ask the computer for a new code.");
    }
  }
});

test("a network failure says the computer cannot be reached", async () => {
  const f: FetchFn = () => Promise.reject(new Error("offline"));
  try {
    await claim(f, "", "ABCD2345", "x");
  } catch (e) {
    assert.ok(e instanceof PairingError && e.code === "network_error");
  }
});

test("start: no token → pairing with the scanned code", async () => {
  const p = await startPhase(fakeFetch([]), "", memoryStorage(), "ABCD-2345");
  assert.deepEqual(p, { kind: "pair", code: "ABCD-2345", notice: null });
});

test("start: a pending device waits, an active one is ready, both send the token as a header", async () => {
  const s = memoryStorage({ [TOKEN_KEY]: TOKEN });
  const f = fakeFetch([
    { status: 200, body: { device_id: "d", name: "iPhone", status: "pending", read_only: false, permissions: ["read"] } },
    { status: 200, body: { device_id: "d", name: "iPhone", status: "active", read_only: false, permissions: ["read", "send"] } },
  ]);
  assert.equal((await startPhase(f, "", s, null)).kind, "waiting");
  assert.equal((await startPhase(f, "", s, null)).kind, "ready");
  assert.equal(f.calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!f.calls[0]?.url.includes("token="));
});

test("start: a revoked or expired token is cleared and the phone pairs again with a plain notice", async () => {
  for (const code of ["device_not_paired", "device_expired"]) {
    const s = memoryStorage({ [TOKEN_KEY]: TOKEN });
    const f = fakeFetch([{ status: 401, body: { error: { code, message: "x" } } }]);
    const p = await startPhase(f, "", s, null);
    assert.deepEqual(p, { kind: "pair", code: "", notice: NOTICE_DISCONNECTED });
    assert.equal(s.data[TOKEN_KEY], undefined);
  }
});

test("only device refusals count as gone", () => {
  assert.equal(isDeviceGone(401, "device_not_paired"), true);
  assert.equal(isDeviceGone(401, "device_expired"), true);
  assert.equal(isDeviceGone(403, "device_pending"), false);
  assert.equal(isDeviceGone(403, "remote_forbidden"), false);
  assert.equal(isDeviceGone(401, undefined), false);
});
