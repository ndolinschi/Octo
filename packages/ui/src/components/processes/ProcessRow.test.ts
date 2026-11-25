import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRun } from "@octo/agent-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProcessRow } from "./ProcessesTab";

const runningRun: CommandRun = {
  id: "run_0001",
  name: "Dev server",
  command: "pnpm dev",
  cwd: "/tmp",
  pid: 1234,
  status: "running",
  exit_code: null,
  started_at: new Date().toISOString(),
  duration_ms: 0,
  output_bytes: 0,
  truncated: false,
};

test("a running command row exposes Stop and Kill in trailing actions", () => {
  const html = renderToStaticMarkup(
    createElement(ProcessRow, {
      item: { kind: "command", key: "cmd:run_0001", run: runningRun, output: "", clipped: false },
      starter: "by you",
      selected: false,
      canManage: true,
      busy: false,
      onSelect: () => {},
      onStop: () => {},
      onKill: () => {},
      onRestart: () => {},
    }),
  );
  assert.match(html, /aria-label="Stop Dev server"/);
  assert.match(html, /aria-label="Kill Dev server"/);
  assert.match(html, /\bocto-row-actions\b/);
  assert.match(html, /size-ctl-md/);
});