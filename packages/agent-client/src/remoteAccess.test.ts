import assert from "node:assert/strict";
import test from "node:test";
import { remoteAccessApi, type RemoteStatus } from "./remoteAccess";

test("every control call goes to its /v1/remote route with its body", async () => {
  const seen: { method: string; path: string; body: unknown }[] = [];
  const status = { state: "off" } as RemoteStatus;
  const api = remoteAccessApi((method, path, body) => {
    seen.push({ method, path, body });
    return Promise.resolve(status);
  });
  assert.equal(await api.status(), status);
  await api.enable();
  await api.enable(true);
  await api.disable();
  await api.check();
  await api.issueCode();
  await api.cancelCode();
  await api.confirmDevice("dev/1");
  await api.setReadOnly("dev_2", true);
  await api.revokeDevice("dev_3");
  await api.revokeAll();
  assert.deepEqual(seen, [
    { method: "GET", path: "/v1/remote", body: undefined },
    { method: "POST", path: "/v1/remote/enable", body: {} },
    { method: "POST", path: "/v1/remote/enable", body: { acknowledge: true } },
    { method: "POST", path: "/v1/remote/disable", body: undefined },
    { method: "POST", path: "/v1/remote/check", body: undefined },
    { method: "POST", path: "/v1/remote/pairing", body: undefined },
    { method: "DELETE", path: "/v1/remote/pairing", body: undefined },
    { method: "POST", path: "/v1/remote/devices/dev%2F1/confirm", body: undefined },
    { method: "PATCH", path: "/v1/remote/devices/dev_2", body: { read_only: true } },
    { method: "DELETE", path: "/v1/remote/devices/dev_3", body: undefined },
    { method: "POST", path: "/v1/remote/revoke-all", body: undefined },
  ]);
});
