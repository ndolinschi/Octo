import assert from "node:assert/strict";
import test from "node:test";
import { plainPluginProblem } from "./pluginProblems";

const plugins = [
  { name: "web-tools", language_servers: [{ id: "gopls", label: "gopls", languages: ["go"], available: true }], agents: [] },
  { name: "systems", language_servers: [], agents: [] },
];

test("plainPluginProblem: a duplicate names both plugins and the one used", () => {
  assert.equal(
    plainPluginProblem("systems", 'languageServers[1]: duplicate id "gopls" (already defined by web-tools)', plugins),
    "Two plugins define the gopls language help entry; the one from web-tools is used.",
  );
  // The harness's current wording names no owner: it is found in the list.
  assert.equal(
    plainPluginProblem("systems", 'languageServers[1]: duplicate language server id "gopls"', plugins),
    "Two plugins define the gopls language help entry; the one from web-tools is used.",
  );
  assert.equal(plainPluginProblem("systems", 'agents[0]: duplicate agent id "x"', plugins), "systems defines the x agent twice; the first one is used.");
});

test("plainPluginProblem: anything else says which part is wrong", () => {
  assert.equal(
    plainPluginProblem("systems", "toolServers[0]: url: must be http or https", plugins),
    "One extra tool in systems is set up wrongly and was skipped.",
  );
  assert.equal(plainPluginProblem("systems", "plugin.json: unexpected end of JSON input", plugins), "systems could not be loaded completely.");
});
