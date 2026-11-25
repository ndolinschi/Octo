import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice } from "../../primitives/Notice";
import { runPhoneMoreCommand, runPhoneMoreCreateSession, type PhoneMoreAsyncHooks } from "./phoneMoreActions";

type FakeSession = { id: string; title: string };

function makeSession(id = "sess-2"): FakeSession {
  return { id, title: "New session" };
}

function makeHarness() {
  let pending: string | null = null;
  let problem: string | null = null;
  let closed = false;
  const pendingHistory: (string | null)[] = [];
  const afterClose: (() => void)[] = [];
  const hooks: PhoneMoreAsyncHooks = {
    setPending: (v) => {
      pending = v;
      pendingHistory.push(v);
    },
    setProblem: (v) => {
      problem = v;
    },
    closeAndRun: (fn) => {
      closed = true;
      afterClose.push(fn);
    },
  };
  return {
    hooks,
    get pending() {
      return pending;
    },
    get problem() {
      return problem;
    },
    get closed() {
      return closed;
    },
    pendingHistory,
    flushAfterClose() {
      for (const fn of afterClose.splice(0)) fn();
    },
  };
}

test("failed createSession keeps PhoneMoreSheet open, clears busy state, and sets error notice", async () => {
  const h = makeHarness();
  let resolveReject!: (e: Error) => void;
  const applied: FakeSession[] = [];
  const shown: string[] = [];
  let refreshed = 0;

  const p = runPhoneMoreCreateSession(
    {
      projectId: "proj-1",
      createSession: () =>
        new Promise<{ session: FakeSession }>((_, reject) => {
          resolveReject = reject;
        }),
      applySession: ({ session }) => applied.push(session),
      refreshSessions: () => {
        refreshed += 1;
      },
      showSession: (id) => shown.push(id),
    },
    h.hooks,
  );

  // While pending: sheet stays open with busy state
  assert.equal(h.closed, false);
  assert.equal(h.pending, "new-session");
  assert.equal(h.problem, null);

  resolveReject(new Error("bridge unreachable."));
  const ok = await p;

  assert.equal(ok, false);
  assert.equal(h.closed, false, "sheet must remain open on createSession failure");
  assert.equal(h.pending, null);
  assert.equal(h.problem, "The session was not created: bridge unreachable. Try again from the menu.");
  assert.deepEqual(applied, []);
  assert.deepEqual(shown, []);
  assert.equal(refreshed, 0);

  // Notice renders the error inside the sheet
  const html = renderToStaticMarkup(createElement(Notice, { tone: "error" }, h.problem));
  assert.match(html, /role="alert"/);
  assert.match(html, /The session was not created: bridge unreachable\. Try again from the menu\./);
});

test("successful createSession stays open while pending, then closes and activates the new session", async () => {
  const h = makeHarness();
  const created = makeSession("sess-42");
  let resolveCreate!: (v: { session: FakeSession }) => void;
  const applied: FakeSession[] = [];
  const shown: string[] = [];
  let refreshed = 0;

  const p = runPhoneMoreCreateSession(
    {
      projectId: "proj-1",
      createSession: () =>
        new Promise<{ session: FakeSession }>((resolve) => {
          resolveCreate = resolve;
        }),
      applySession: ({ session }) => applied.push(session),
      refreshSessions: () => {
        refreshed += 1;
      },
      showSession: (id) => shown.push(id),
    },
    h.hooks,
  );

  assert.equal(h.closed, false);
  assert.equal(h.pending, "new-session");

  resolveCreate({ session: created });
  const ok = await p;

  assert.equal(ok, true);
  assert.equal(h.closed, true, "sheet closes on createSession success");
  assert.equal(h.pending, null);
  assert.equal(h.problem, null);

  h.flushAfterClose();
  assert.deepEqual(applied, [created]);
  assert.equal(refreshed, 1);
  assert.deepEqual(shown, ["sess-42"]);
});

test("failed startProjectRun keeps PhoneMoreSheet open and displays the error notice", async () => {
  const h = makeHarness();
  let resolveRun!: (v: { runId: string } | { problem: string }) => void;
  const opened: string[] = [];

  const p = runPhoneMoreCommand(
    {
      name: "Dev",
      alreadyRunning: false,
      startRun: () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
      openRun: (name) => opened.push(name),
    },
    h.hooks,
  );

  assert.equal(h.closed, false);
  assert.equal(h.pending, "run:dev");

  resolveRun({ problem: "Dev did not start: command not found. Check the command in Settings, then run it again." });
  const ok = await p;

  assert.equal(ok, false);
  assert.equal(h.closed, false, "sheet must remain open on startProjectRun failure");
  assert.equal(h.pending, null);
  assert.equal(h.problem, "Dev did not start: command not found. Check the command in Settings, then run it again.");
  assert.deepEqual(opened, []);

  const html = renderToStaticMarkup(createElement(Notice, { tone: "error" }, h.problem));
  assert.match(html, /role="alert"/);
  assert.match(html, /Dev did not start: command not found\./);
});

test("successful startProjectRun closes the sheet and opens the run tab", async () => {
  const h = makeHarness();
  const opened: string[] = [];

  const ok = await runPhoneMoreCommand(
    {
      name: "Dev",
      alreadyRunning: false,
      startRun: () => Promise.resolve({ runId: "run-1" }),
      openRun: (name) => opened.push(name),
    },
    h.hooks,
  );

  assert.equal(ok, true);
  assert.equal(h.closed, true);
  assert.equal(h.pending, null);
  assert.equal(h.problem, null);
  assert.deepEqual(h.pendingHistory, ["run:dev", null]);

  h.flushAfterClose();
  assert.deepEqual(opened, ["Dev"]);
});

test("already-running command closes immediately and opens the run tab without starting again", async () => {
  const h = makeHarness();
  const opened: string[] = [];
  let startCalls = 0;

  const ok = await runPhoneMoreCommand(
    {
      name: "Dev",
      alreadyRunning: true,
      startRun: () => {
        startCalls += 1;
        return Promise.resolve({ runId: "run-1" });
      },
      openRun: (name) => opened.push(name),
    },
    h.hooks,
  );

  assert.equal(ok, true);
  assert.equal(startCalls, 0);
  assert.equal(h.closed, true);
  assert.deepEqual(h.pendingHistory, []);

  h.flushAfterClose();
  assert.deepEqual(opened, ["Dev"]);
});
