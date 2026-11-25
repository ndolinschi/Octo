import assert from "node:assert/strict";
import test from "node:test";
import { isShellLang, onTerminalCommand, queueTerminalCommand, takeTerminalCommand } from "./terminalRun";

test("isShellLang recognizes shell languages only", () => {
  assert.equal(isShellLang("bash"), true);
  assert.equal(isShellLang("SH"), true);
  assert.equal(isShellLang("zsh"), true);
  assert.equal(isShellLang("shell"), true);
  assert.equal(isShellLang("typescript"), false);
  assert.equal(isShellLang(undefined), false);
});

test("queueTerminalCommand notifies listeners and takeTerminalCommand consumes once", () => {
  takeTerminalCommand();
  let notified = 0;
  const unsub = onTerminalCommand(() => {
    notified += 1;
  });
  queueTerminalCommand("   ");
  assert.equal(notified, 0);
  assert.equal(takeTerminalCommand(), null);

  queueTerminalCommand("  pnpm test \n");
  assert.equal(notified, 1);
  assert.equal(takeTerminalCommand(), "pnpm test");
  assert.equal(takeTerminalCommand(), null);
  unsub();
});
