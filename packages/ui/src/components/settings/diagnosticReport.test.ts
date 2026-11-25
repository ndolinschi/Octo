import assert from "node:assert/strict";
import test from "node:test";
import type { Diagnostics } from "@octo/agent-client";
import { diagnosticReport } from "./diagnosticReport";

const d: Diagnostics = {
  generated_at: "2026-11-11T10:00:00Z",
  version: "1.2.3",
  go_version: "go1.26.0",
  os: "linux",
  arch: "amd64",
  data_dir: "/home/u/.local/share/octo",
  path_for_children: "/usr/bin:/bin",
  env_set: ["ANTHROPIC_API_KEY"],
  builtin_loop: { available: false, reason: "No API key" },
  router: { base_url: "", detected: false, capabilities: [] },
  agents: [
    {
      id: "copilot",
      label: "GitHub Copilot",
      available: true,
      command: "/usr/bin/copilot",
      requires: [],
      probe: { ran: true, logged_in: false, reason: "exit status 1" },
      flat_rate: true,
    },
    {
      id: "grok",
      label: "Grok",
      available: false,
      command: "not found",
      unavailable_reason: "grok: not on PATH",
      requires: [],
      probe: { ran: false, logged_in: null, reason: "" },
      flat_rate: true,
    },
  ],
  acp_trace: { enabled: true, dir: "/t", files: ["a.jsonl"] },
  log_tail: ["level=INFO msg=start"],
  problems: ["Copilot is not logged in"],
};

test("diagnosticReport: versions, agents with their state, problems and the log tail", () => {
  const text = diagnosticReport(d, { bridgeUrl: "http://127.0.0.1:8790", shell: "desktop" });
  assert.match(text, /Harness 1\.2\.3 \(go1\.26\.0, linux\/amd64\); desktop shell; bridge http:\/\/127\.0\.0\.1:8790/);
  assert.match(text, /GitHub Copilot \(copilot\): \/usr\/bin\/copilot; not logged in; exit status 1/);
  assert.match(text, /Grok \(grok\): not found; not available — grok: not on PATH/);
  assert.match(text, /Built-in loop: unavailable — No API key/);
  assert.match(text, /ACP trace: on, 1 file\(s\) in \/t/);
  assert.match(text, /- Copilot is not logged in/);
  assert.match(text, /Last 1 log lines:\n {2}level=INFO msg=start$/);
  // Names of variables only: the report has no place for a value.
  assert.match(text, /Variables set \(names only\): ANTHROPIC_API_KEY\n/);
});
