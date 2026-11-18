import assert from "node:assert/strict";
import test from "node:test";
import { terminalTabName } from "./terminalTabs";

test("a terminal tab is named by its title, else its shell and folder, else Terminal (never its id)", () => {
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "" }), "zsh · proj");
  assert.equal(terminalTabName({ shell: "zsh", folder: "proj", title: "build" }), "build");
  assert.equal(terminalTabName({ shell: "", folder: "", title: "" }), "Terminal");
  assert.equal(terminalTabName(undefined), "Terminal");
});
