import assert from "node:assert/strict";
import test from "node:test";
import { fileUri, fromFileUri } from "./uri";

const folders = [
  { label: "infra", path: "/Users/maya/code/infra" },
  { label: "web", path: "/Users/maya/code/infra/web" },
  { label: "other", path: "/Users/maya/code/infra-web" },
];

test("POSIX folders and relative paths become file:/// URIs", () => {
  assert.equal(fileUri("/Users/maya/code/infra", "src/a.ts"), "file:///Users/maya/code/infra/src/a.ts");
  assert.equal(fileUri("/Users/maya/code/infra"), "file:///Users/maya/code/infra", "no relative path: the folder itself");
  assert.equal(fileUri("/Users/maya/code/infra/", "x"), "file:///Users/maya/code/infra/x", "a trailing slash on the folder is harmless");
});

test("each path segment is percent-encoded, slashes between segments are not", () => {
  assert.equal(fileUri("/My Code/proj", "src/a b/ü#?.ts"), "file:///My%20Code/proj/src/a%20b/%C3%BC%23%3F.ts");
  assert.equal(fileUri("/p", "日本/語.md"), "file:///p/%E6%97%A5%E6%9C%AC/%E8%AA%9E.md");
});

test("a Windows drive stays readable; backslashes are separators", () => {
  assert.equal(fileUri("C:\\Users\\maya\\app", "src\\a.ts"), "file:///C:/Users/maya/app/src/a.ts");
  assert.equal(fileUri("c:/x", "y"), "file:///c:/x/y");
});

test("URIs map back to the project folder and relative path", () => {
  assert.deepEqual(fromFileUri("file:///Users/maya/code/infra/src/a.ts", folders), { folder: "infra", path: "src/a.ts" });
  assert.deepEqual(fromFileUri(fileUri("/My Code/proj", "a b/ü.ts"), [{ label: "p", path: "/My Code/proj" }]), { folder: "p", path: "a b/ü.ts" });
});

test("the deepest matching folder wins, and a name sharing a prefix does not match", () => {
  assert.deepEqual(fromFileUri("file:///Users/maya/code/infra/web/x.ts", folders), { folder: "web", path: "x.ts" });
  assert.deepEqual(fromFileUri("file:///Users/maya/code/infra-web/x.ts", folders), { folder: "other", path: "x.ts" });
  assert.equal(fromFileUri("file:///Users/maya/code/infra-webx/x.ts", folders), null);
  const nested = [...folders].reverse();
  assert.deepEqual(fromFileUri("file:///Users/maya/code/infra/web/x.ts", nested), { folder: "web", path: "x.ts" }, "order of folders does not matter");
});

test("outside the project, the folder root itself, other schemes and foreign hosts are null", () => {
  assert.equal(fromFileUri("file:///etc/hosts", folders), null);
  assert.equal(fromFileUri("file:///Users/maya/code/infra", folders), null);
  assert.equal(fromFileUri("https://example.com/Users/maya/code/infra/a.ts", folders), null);
  assert.equal(fromFileUri("file://remote-host/Users/maya/code/infra/a.ts", folders), null);
  assert.equal(fromFileUri("", folders), null);
  assert.equal(fromFileUri("file:///Users/maya/code/infra/a.ts", []), null);
});

test("query, fragment and malformed escapes", () => {
  assert.deepEqual(fromFileUri("file:///Users/maya/code/infra/a.ts?x=1#L3", folders), { folder: "infra", path: "a.ts" });
  assert.equal(fromFileUri("file:///Users/maya/code/infra/%E0%A4%A.ts", folders), null);
});

test("drive letters compare case-insensitively (servers send c%3A or C:)", () => {
  const win = [{ label: "app", path: "C:\\Users\\maya\\app" }];
  assert.deepEqual(fromFileUri("file:///c:/Users/maya/app/src/a.ts", win), { folder: "app", path: "src/a.ts" });
  assert.deepEqual(fromFileUri("file:///c%3A/Users/maya/app/src/a.ts", win), { folder: "app", path: "src/a.ts" });
  assert.equal(fromFileUri("file:///d:/Users/maya/app/src/a.ts", win), null);
});
