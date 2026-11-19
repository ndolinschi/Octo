import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type Bridge, type FetchLike } from "./client";
import { createMessageClient, serveBridge, type MessagePortLike } from "./messageBridge";
import type { BranchesResult, RepoBranches } from "./types";

type Call = { url: string; method: string | undefined; body: unknown };

function bridgeWith(status: number, body: string) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

const repo: RepoBranches = {
  folder_id: "fld_1",
  folder: "app",
  folders: ["app"],
  repo_root: "/src/app",
  repo_name: "app",
  branch: "main",
  detached: false,
  head: "9c1e2f3",
  dirty_files: 0,
  branches: [{ name: "main", current: true, ahead: 0, behind: 0, commit: { sha: "9c1e", subject: "init", date: "2026-11-19T08:00:00Z" } }],
  total: 1,
};

test("listBranches builds the query and returns the answer", async () => {
  const res: BranchesResult = { workspace: "shared", running_sessions: 0, repos: [repo] };
  let r = bridgeWith(200, JSON.stringify(res));
  assert.deepEqual(await r.bridge.listBranches?.("p"), res);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/branches");

  r = bridgeWith(200, JSON.stringify(res));
  await r.bridge.listBranches?.("p", { folder: "my app", workspace: "wrk_1", q: "fix/a", offset: 30, limit: 30 });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/branches?folder=my%20app&workspace=wrk_1&q=fix%2Fa&offset=30&limit=30");
});

test("switchBranch posts the body and unwraps the repository", async () => {
  const r = bridgeWith(200, JSON.stringify({ repo: { ...repo, branch: "feature/x" } }));
  const out = await r.bridge.switchBranch?.("p", { branch: "feature/x", create: true, folder: "fld_1" });
  assert.equal(out?.branch, "feature/x");
  assert.deepEqual(
    [r.calls[0]?.method, r.calls[0]?.url, r.calls[0]?.body],
    ["POST", "http://h:1/v1/projects/p/branches/switch", { branch: "feature/x", create: true, folder: "fld_1" }],
  );
});

test("a refused switch keeps its hint, details and the use_worktree action", async () => {
  const body = {
    error: {
      code: "uncommitted_changes",
      message: "The main checkout has uncommitted changes, so it stays on its branch.",
      hint: "Start in a worktree from that branch instead. Your changes stay where they are.",
      action: "use_worktree",
      details: "a.txt",
    },
  };
  const r = bridgeWith(409, JSON.stringify(body));
  await assert.rejects(r.bridge.switchBranch?.("p", { branch: "older" }) ?? Promise.reject(new Error("no switchBranch")), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "uncommitted_changes");
    assert.equal(e.action, "use_worktree");
    assert.equal(e.details, "a.txt");
    assert.ok((e.hint ?? "").includes("worktree"));
    return true;
  });
});

function portPair(): { a: MessagePortLike; b: MessagePortLike } {
  type Listener = (msg: unknown) => void;
  const la = new Set<Listener>();
  const lb = new Set<Listener>();
  const mk = (out: Set<Listener>, inn: Set<Listener>): MessagePortLike => ({
    postMessage(msg) {
      const copy = msg === undefined ? msg : (JSON.parse(JSON.stringify(msg)) as unknown);
      void Promise.resolve().then(() => out.forEach((cb) => cb(copy)));
    },
    onMessage(cb) {
      inn.add(cb);
      return () => void inn.delete(cb);
    },
  });
  return { a: mk(lb, la), b: mk(la, lb) };
}

test("the message-port bridge forwards the branch methods and a structured refusal", async () => {
  const { a, b } = portPair();
  const log: unknown[][] = [];
  const host = {
    listBranches: async (...args: unknown[]) => {
      log.push(["listBranches", ...args]);
      return { workspace: "shared", running_sessions: 0, repos: [repo] };
    },
    switchBranch: async () => {
      throw new BridgeError(409, "checkout_in_use", "A session is working in the main checkout, so it stays on its branch.", {
        hint: "Start in a worktree from that branch instead, or wait until the session ends.",
        action: "use_worktree",
        details: "1 running",
      });
    },
  } as unknown as Bridge;
  serveBridge(b, host);
  const client = createMessageClient(a).bridge;
  const listed = await client.listBranches?.("p", { q: "ma" });
  assert.equal(listed?.repos[0]?.branch, "main");
  assert.deepEqual(log, [["listBranches", "p", { q: "ma" }]]);
  await assert.rejects(client.switchBranch?.("p", { branch: "x" }) ?? Promise.reject(new Error("no switchBranch")), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "checkout_in_use");
    assert.equal(e.action, "use_worktree");
    assert.equal(e.details, "1 running");
    assert.ok((e.hint ?? "").includes("worktree"));
    return true;
  });
});

test("a host without the branch methods answers unsupported, not a crash", async () => {
  const { a, b } = portPair();
  serveBridge(b, {} as Bridge);
  const client = createMessageClient(a).bridge;
  await assert.rejects(client.listBranches?.("p") ?? Promise.reject(new Error("no listBranches")), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "unsupported");
    return true;
  });
});
