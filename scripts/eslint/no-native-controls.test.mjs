import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Linter } from "eslint";
import rule, { isAllowed } from "./no-native-controls.mjs";

const ROOT = path.resolve("/repo/packages/ui/src");

/** Lint `code` as `rel` (relative to the UI root); returns the rule's messages. */
function lint(code, rel, options = {}) {
  const linter = new Linter({ configType: "flat", cwd: "/repo" });
  return linter.verify(
    code,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { octo: { rules: { "no-native-controls": rule } } },
        rules: { "octo/no-native-controls": ["warn", { root: ROOT, ...options }] },
      },
    ],
    { filename: path.join(ROOT, rel) },
  );
}

test("isAllowed matches the primitives folder and nothing beside it", () => {
  const allow = ["components/primitives"];
  assert.ok(isAllowed(ROOT, path.join(ROOT, "components/primitives/Button.tsx"), allow));
  assert.ok(isAllowed(ROOT, path.join(ROOT, "components/primitives/deep/X.tsx"), allow));
  assert.ok(!isAllowed(ROOT, path.join(ROOT, "components/primitivesX/Button.tsx"), allow));
  assert.ok(!isAllowed(ROOT, path.join(ROOT, "components/chat/Composer.tsx"), allow));
  assert.ok(!isAllowed(ROOT, path.join(ROOT, "app/OctoApp.tsx"), allow));
  assert.ok(isAllowed(ROOT, "/elsewhere/Button.tsx", allow), "files outside the UI root are not this rule's business");
});

test("reports each native control in a feature file, as a warning", () => {
  const code = `export const X = () => (<div><button>a</button><input /><select /><textarea /><dialog /></div>);`;
  const messages = lint(code, "components/chat/X.tsx");
  assert.deepEqual(
    messages.map((m) => m.message.match(/<(\w+)>/)?.[1]),
    ["button", "input", "select", "textarea", "dialog"],
  );
  assert.ok(messages.every((m) => m.severity === 1 && m.ruleId === "octo/no-native-controls"));
});

test("reports the opening element once, with children or self-closing", () => {
  assert.equal(lint(`const X = () => <button type="button">ok</button>;`, "components/files/X.tsx").length, 1);
  assert.equal(lint(`const X = () => <input type="checkbox" />;`, "components/files/X.tsx").length, 1);
});

test("allows native controls inside components/primitives", () => {
  const code = `export const B = () => <button type="button" />;`;
  assert.equal(lint(code, "components/primitives/Button.tsx").length, 0);
});

test("does not report components, other elements or member tags", () => {
  const code = `const X = () => (<div><Button /><label /><Foo.button /><span role="button" /><Input /></div>);`;
  assert.equal(lint(code, "components/chat/X.tsx").length, 0);
});

test("a different allow list moves the exception", () => {
  const code = `const X = () => <button />;`;
  assert.equal(lint(code, "components/shared/X.tsx", { allow: ["components/shared"] }).length, 0);
  assert.equal(lint(code, "components/primitives/X.tsx", { allow: ["components/shared"] }).length, 1);
});
