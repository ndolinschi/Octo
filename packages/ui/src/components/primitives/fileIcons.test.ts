import { AlignLeft, Braces, CodeXml, File, Image } from "lucide-react";
import assert from "node:assert/strict";
import test from "node:test";
import { fileIcon, isMarkdown } from "./fileIcons";

test("icons are chosen by extension, ignoring case", () => {
  assert.equal(fileIcon("main.go"), CodeXml);
  assert.equal(fileIcon("App.TSX"), CodeXml);
  assert.equal(fileIcon("styles.css"), CodeXml);
  assert.equal(fileIcon("package.json"), Braces);
  assert.equal(fileIcon("config.YML"), Braces);
  assert.equal(fileIcon("README.md"), AlignLeft);
  assert.equal(fileIcon("logo.PNG"), Image);
});

test("known configuration names win; dotfiles and extensionless names are generic otherwise", () => {
  for (const name of [".gitignore", ".env", ".env.example", "Dockerfile", "Makefile", "Podfile"]) assert.equal(fileIcon(name), Braces, name);
  assert.equal(fileIcon("LICENSE"), File);
  assert.equal(fileIcon(".hidden"), File, "a leading dot is not an extension");
  assert.equal(fileIcon("archive.unknownext"), File);
  assert.equal(fileIcon("trailing."), File);
  assert.equal(fileIcon(""), File);
});

test(
  "an extension named like an object property is not an icon",
  { todo: "fileIcon(): BY_EXT and BY_NAME are plain objects, so 'x.constructor' returns Object as the icon component (fileIcons.ts fileIcon)" },
  () => {
    assert.equal(fileIcon("x.constructor"), File);
    assert.equal(fileIcon("x.toString"), File);
  },
);

test("only .md and .markdown open in the preview", () => {
  assert.equal(isMarkdown("docs/a.md"), true);
  assert.equal(isMarkdown("A.MARKDOWN"), true);
  assert.equal(isMarkdown("a.mdx"), false);
  assert.equal(isMarkdown("md"), false);
  assert.equal(isMarkdown("a.md.bak"), false);
});
