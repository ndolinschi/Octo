import assert from "node:assert/strict";
import test from "node:test";
import { terminalOrdinals, terminalTabName } from "./ordinals";

test("terminalOrdinals numbers tabs that share a name in open order; the first keeps its name", () => {
  assert.deepEqual(terminalOrdinals(["zsh · proj", "bash · proj", "zsh · proj", "zsh · proj"]), [0, 0, 2, 3]);
  assert.deepEqual(terminalOrdinals(["zsh"]), [0]);
  assert.deepEqual(terminalOrdinals([]), []);
});

test("terminalTabName: own title, else shell and folder", () => {
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "" }), "zsh · proj");
  assert.equal(terminalTabName({ shell: "", folder: "", title: "" }), "Terminal");
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "Logs" }), "Logs");
});
