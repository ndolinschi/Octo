import assert from "node:assert/strict";
import test from "node:test";
import { imageSource } from "./markdownImage";

test("images inline in the text or local to the app render as they are", () => {
  assert.deepEqual(imageSource("data:image/png;base64,iVBORw0KGgo="), { kind: "inline" });
  assert.deepEqual(imageSource("blob:http://127.0.0.1:1420/7f9c"), { kind: "inline" });
  assert.deepEqual(imageSource("docs/diagram.png"), { kind: "inline" });
  assert.deepEqual(imageSource("./a b.svg"), { kind: "inline" });
});

test("a remote image is never fetched by itself: it names its host and waits for the person (security review 4b)", () => {
  assert.deepEqual(imageSource("https://evil.example/x.png?d=secret"), { kind: "remote", host: "evil.example" });
  assert.deepEqual(imageSource("HTTP://Example.COM:8080/a.gif"), { kind: "remote", host: "example.com:8080" });
  assert.deepEqual(imageSource("//cdn.example/p.png"), { kind: "remote", host: "cdn.example" });
  assert.deepEqual(imageSource(" https://evil.example/x"), { kind: "remote", host: "evil.example" });
});

test("anything else is not loaded at all", () => {
  for (const src of [undefined, "", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "ftp://h/x.png", "https://"]) {
    assert.deepEqual(imageSource(src), { kind: "blocked" }, String(src));
  }
});
