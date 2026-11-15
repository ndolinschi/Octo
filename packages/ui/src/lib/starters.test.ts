import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STARTERS, prompts } from "./starters";

const atlas = { folders: [{ id: "f", label: "atlas-api", path: "/x/atlas-api" }] };

test("starters are specific to the project (decision 52): they name its folder, none without one", () => {
  assert.deepEqual(prompts({ folders: [] }), []);
  assert.deepEqual(prompts({ folders: [] }, { scripts: [{ name: "test", command: "pnpm test" }], top: [] }), []);
  const p = prompts(atlas);
  assert.ok(p.length >= 1 && p.length <= MAX_STARTERS);
  assert.ok(p.every((s) => s.text.includes("atlas-api")));
});

test("C4: nothing about uncommitted changes (no git status in the local service)", () => {
  const all = [
    prompts(atlas),
    prompts(atlas, { scripts: [{ name: "test", command: "pnpm test" }], top: ["README.md", ".git", "src"] }),
    prompts(atlas, { scripts: [], top: [] }),
  ].flat();
  assert.ok(all.every((s) => !/uncommitted/i.test(s.title + s.text)));
});

test("C4: an empty folder gets its own pair (dotfiles do not count)", () => {
  const p = prompts(atlas, { scripts: [], top: [".git", ".DS_Store"] });
  assert.deepEqual(
    p.map((s) => s.title),
    ["Set up a new project here", "Plan the first version with me"],
  );
});

test("C4: test and lint scripts first, with their command lines, then the README; at most three", () => {
  const p = prompts(atlas, {
    scripts: [
      { name: "dev", command: "pnpm run dev" },
      { name: "lint", command: "pnpm run lint" },
      { name: "test", command: "pnpm run test" },
    ],
    top: ["README.md", "package.json", "src", ".git"],
  });
  assert.deepEqual(
    p.map((s) => s.title),
    ["Run the tests and fix what fails", "Run lint and fix the warnings", "What is this project?"],
  );
  assert.ok(p[0]?.text.includes("`pnpm run test`"));
  assert.ok(p[1]?.text.includes("`pnpm run lint`"));
  assert.ok(p[2]?.text.includes("README.md"));
});

test("C4: only a README → README, structure; history only with .git", () => {
  assert.deepEqual(
    prompts(atlas, { scripts: [], top: ["readme.md", "notes.txt"] }).map((s) => s.title),
    ["What is this project?", "Explain the structure of atlas-api"],
  );
  assert.deepEqual(
    prompts(atlas, { scripts: null, top: ["src", ".git"] }).map((s) => s.title),
    ["Explain the structure of atlas-api", "What changed recently?"],
  );
});

test("C4: nothing known → the structure only (no promise the folder cannot keep)", () => {
  assert.deepEqual(
    prompts(atlas).map((s) => s.title),
    ["Explain the structure of atlas-api"],
  );
});
