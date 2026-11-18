import assert from "node:assert/strict";
import test from "node:test";
import { closeTerminalTab, getTerminalTabState, terminalOrdinals, terminalTabName, updateTerminalTabState } from "./terminalTabs";

test("terminalOrdinals numbers tabs that share a name in open order; the first keeps its name", () => {
  const got = terminalOrdinals([
    { id: "a", name: "zsh · proj" },
    { id: "b", name: "bash · proj" },
    { id: "c", name: "zsh · proj" },
    { id: "d", name: "zsh · proj" },
  ]);
  assert.deepEqual(
    [...got],
    [
      ["c", 2],
      ["d", 3],
    ],
  );
  assert.equal(terminalOrdinals([{ id: "a", name: "zsh" }]).size, 0);
});

test("terminalTabName: own title, else shell and folder", () => {
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "" }), "zsh · proj");
  assert.equal(terminalTabName({ shell: "", folder: "", title: "" }), "Terminal");
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "Logs" }), "Logs");
});

test("getTerminalTabState carries the ordinal of a duplicate, per project", () => {
  updateTerminalTabState("p1", "t1", { shell: "zsh", folder: "proj" });
  updateTerminalTabState("p1", "t2", { shell: "zsh", folder: "proj" });
  updateTerminalTabState("p2", "t3", { shell: "zsh", folder: "proj" });
  assert.equal(getTerminalTabState("p1", "t1").ordinal, undefined);
  assert.equal(getTerminalTabState("p1", "t2").ordinal, 2);
  assert.equal(getTerminalTabState("p2", "t3").ordinal, undefined);
  closeTerminalTab("p1", "t1");
  assert.equal(getTerminalTabState("p1", "t2").ordinal, undefined);
});
