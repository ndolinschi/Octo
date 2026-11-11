import assert from "node:assert/strict";
import test from "node:test";
import { languageOf, tokenize } from "./highlight";

const join = (code: string, lang: string) => (tokenize(code, lang) ?? []).map((t) => t.text).join("");
const kinds = (code: string, lang: string) => (tokenize(code, lang) ?? []).filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text.trim()}`);

test("tokens reproduce the code exactly (the block keeps its size)", () => {
  const samples: [string, string][] = [
    ["ts", "const a = `x ${y}`; // hi\nexport function f(): Money { return 1_000n; }"],
    ["go", "func total(lines []Line) int64 {\n\tvar sum int64\n\treturn sum // ok\n}"],
    ["json", '{ "a": 1, "b": [true, null, "s"] }'],
    ["bash", 'pnpm settle --region eu | jq ".x" # done\necho $HOME'],
    ["diff", "@@ -1 +1 @@\n-old\n+new\n ctx\n"],
    ["python", 'def f(x):\n    """doc"""\n    return x  # c'],
    ["sql", "select * from t where a = 'x' -- c"],
  ];
  for (const [lang, code] of samples) assert.equal(join(code, lang), code, lang);
});

test("keywords, strings, comments, numbers and types get their kinds", () => {
  assert.deepEqual(
    kinds("const x = 'a'; // c", "ts").filter((k) => !k.startsWith("muted")),
    ["keyword:const", "string:'a'", "comment:// c"],
  );
  assert.ok(kinds("let n: Money = 42", "typescript").includes("type:Money"));
  assert.ok(kinds("let n = 42", "js").includes("number:42"));
  assert.ok(kinds("var sum int64", "go").includes("type:int64"));
  assert.ok(kinds('{"key": "value"}', "json").includes('keyword:"key"'));
  assert.ok(kinds('{"key": "value"}', "json").includes('string:"value"'));
});

test("diff lines are added / removed / hunk", () => {
  assert.deepEqual(kinds("@@ -1 +1 @@\n-a\n+b\n", "diff"), ["keyword:@@ -1 +1 @@", "removed:-a", "added:+b"]);
});

test("unknown languages stay plain", () => {
  assert.equal(tokenize("anything", "brainfuck"), null);
  assert.equal(tokenize("anything", undefined), null);
  assert.equal(languageOf("TSX"), "ts");
  assert.equal(languageOf("shell"), "bash");
});
