// Every third-party action in .github/workflows is pinned to a full commit SHA with its tag in a comment, so a moved
// or hijacked tag cannot change what CI runs (security review finding 7c). Update: resolve the new tag with
// `git ls-remote https://github.com/<owner>/<action> refs/tags/<tag> 'refs/tags/<tag>^{}'` (the `^{}` line is the
// commit of an annotated tag) and replace both the SHA and the comment.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const dir = join(import.meta.dirname, "..", ".github", "workflows");

test("workflow actions are pinned to commit SHAs with the tag in a comment", () => {
  const bad = [];
  let seen = 0;
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
        if (!m) return;
        seen++;
        const [, ref, rest] = m;
        if (ref.startsWith("./")) return;
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref) || !/#\s*\S+/.test(rest)) bad.push(`${name}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.ok(seen > 0, "no `uses:` lines found");
  assert.deepEqual(bad, []);
});
