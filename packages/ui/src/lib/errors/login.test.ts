import assert from "node:assert/strict";
import test from "node:test";
import { loginSteps, withLoginSteps } from "./login";

test("manifest command and the /login step", () => {
  const s = loginSteps({ logged_in: false, login_command: "copilot", hint: "Run `copilot`, then type `/login` in it." });
  assert.deepEqual(s, { command: "copilot", hint: "Run it in a terminal, then type /login, then check again." });
});

test("command from the hint when the manifest has none; no step, no hint", () => {
  assert.deepEqual(loginSteps({ hint: "Run `claude auth login` in a terminal." }), { command: "claude auth login" });
});

test("logged in, unknown agent or no command gives nothing", () => {
  assert.equal(loginSteps({ logged_in: true, login_command: "x" }), null);
  assert.equal(loginSteps(undefined), null);
  assert.equal(loginSteps({ logged_in: false, hint: "Log in somehow." }), null);
});

test("withLoginSteps keeps the harness's own command and fills a missing one", () => {
  const steps = { command: "copilot", hint: "Run it in a terminal, then type /login, then check again." };
  assert.deepEqual(withLoginSteps({ command: "own" }, steps), { command: "own" });
  assert.deepEqual(withLoginSteps({ hint: "Log in to it in a terminal, then check again." }, steps), { command: "copilot", hint: steps.hint });
  assert.deepEqual(withLoginSteps(undefined, { command: "c" }), { command: "c" });
  assert.equal(withLoginSteps({ hint: "h" }, null)?.hint, "h");
});
