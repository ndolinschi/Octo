import assert from "node:assert/strict";
import test from "node:test";
import { deviceMay, mayChangeProject, sectionLocked, type RemoteDevice } from "./remoteDevice";

const full: RemoteDevice = { readOnly: false, permissions: ["send", "answer", "stop"] };
const readOnly: RemoteDevice = { readOnly: true, permissions: ["send", "answer", "stop"] };
const noSend: RemoteDevice = { readOnly: false, permissions: ["answer"] };

test("without a device nothing is locked", () => {
  for (const s of ["general", "providers", "remote", "commands"]) assert.equal(sectionLocked(undefined, s), false);
  assert.equal(deviceMay(undefined, "send"), true);
  assert.equal(mayChangeProject(undefined), true);
});

test("a device keeps only the sections stored on it and About", () => {
  const open = ["general", "appearance", "privacy", "remote", "about", "providers", "models", "integrations", "editor", "commands", "memory", "usage"].filter(
    (s) => !sectionLocked(full, s),
  );
  assert.deepEqual(open, ["general", "appearance", "about"]);
});

test("send, answer and stop follow the device's permissions and its read-only switch", () => {
  assert.equal(deviceMay(full, "send"), true);
  assert.equal(deviceMay(readOnly, "send"), false);
  assert.equal(deviceMay(readOnly, "answer"), false);
  assert.equal(deviceMay(noSend, "send"), false);
  assert.equal(deviceMay(noSend, "answer"), true);
});

test("a device never changes a project", () => {
  assert.equal(mayChangeProject(full), false);
  assert.equal(mayChangeProject(readOnly), false);
});
