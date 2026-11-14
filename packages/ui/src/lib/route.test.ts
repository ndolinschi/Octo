import assert from "node:assert/strict";
import test from "node:test";
import { hrefFor, parseHash, parseSettingsHash, resolveProjectRoute, settingsHref } from "./route";

test("project and agent routes parse", () => {
  assert.deepEqual(parseHash("#/p/atlas"), { projectId: "atlas", agentId: null });
  assert.deepEqual(parseHash("#/p/atlas/a/agent-1"), { projectId: "atlas", agentId: "agent-1" });
});

test("anything that is not a project route is the home route", () => {
  for (const hash of ["", "#", "#/", "#/p", "#/p/", "#/p//a/x", "#/settings", "p/atlas", "#/x/p/atlas"]) {
    assert.deepEqual(parseHash(hash), { projectId: null, agentId: null }, JSON.stringify(hash));
  }
});

test("trailing segments are ignored; an empty agent segment is no agent", () => {
  assert.deepEqual(parseHash("#/p/atlas/other"), { projectId: "atlas", agentId: null });
  assert.deepEqual(parseHash("#/p/atlas/a/x/more/stuff"), { projectId: "atlas", agentId: "x" });
  assert.deepEqual(parseHash("#/p/atlas/a/"), { projectId: "atlas", agentId: null });
});

test("hrefFor and parseHash round trip, including ids that need escaping", () => {
  for (const id of ["atlas", "with space", "a/b", "100%", "q?x=1#y", "naïve-日本語", "🐙"]) {
    for (const agent of [null, undefined, "", "agent 1", "a/b"]) {
      const route = parseHash(hrefFor(id, agent));
      assert.equal(route.projectId, id);
      assert.equal(route.agentId, agent ? agent : null);
    }
  }
  assert.equal(hrefFor("a/b"), "#/p/a%2Fb", "a slash in an id cannot split the path");
});

test("a malformed percent escape in the hash is the home route, not a crash", () => {
  const none = { projectId: null, agentId: null };
  for (const hash of ["#/p/%E0%A4%A", "#/p/%", "#/p/ok/a/%E0%A4%A", "#/p/%FF/a/x", "#/p/a%2"]) assert.deepEqual(parseHash(hash), none, hash);
  assert.deepEqual(parseHash("#/p/a%20b/a/c%2Fd"), { projectId: "a b", agentId: "c/d" }, "well-formed escapes still decode");
});

test("settings hashes: #/settings/<section>, the bare page, and nothing else", () => {
  assert.equal(parseSettingsHash("#/settings/providers"), "providers");
  assert.equal(parseSettingsHash("#/settings"), "");
  assert.equal(parseSettingsHash("#/settings/"), "");
  assert.equal(parseSettingsHash(settingsHref("privacy")), "privacy");
  assert.equal(parseSettingsHash("#/settings/%E0%A4%A"), "");
  for (const hash of ["", "#/", "#/p/atlas", "#/settingsx", "#/settings/a/b"]) assert.equal(parseSettingsHash(hash), null, hash);
  // A settings hash is not a project route.
  assert.deepEqual(parseHash("#/settings/general"), { projectId: null, agentId: null });
});

test("P1-4: the route's project is shown only when it is in the list and not known to be gone", () => {
  const list = [{ id: "a" }, { id: "b" }];
  assert.equal(resolveProjectRoute(null, list, new Set()), "home");
  assert.equal(resolveProjectRoute("a", null, new Set()), "loading");
  assert.equal(resolveProjectRoute("a", list, new Set()), "show");
  // Not in the list (created a moment ago, or never existed): look it up, do not fall back to another project.
  assert.equal(resolveProjectRoute("new", list, new Set()), "check");
  assert.equal(resolveProjectRoute("new", [], new Set()), "check");
  // The harness answered 404: gone, even while a stale list still has it, and even before the list is in.
  assert.equal(resolveProjectRoute("a", list, new Set(["a"])), "missing");
  assert.equal(resolveProjectRoute("a", null, new Set(["a"])), "missing");
  assert.equal(resolveProjectRoute("b", list, new Set(["a"])), "show");
});
