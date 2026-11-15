import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteDevice, RemoteStatus } from "@octo/agent-client";
import { countdown, deviceLine, indicatorText, stateLine } from "./remoteText";

const base: RemoteStatus = {
  state: "off",
  connected: false,
  cloudflared: { found: true, install: "brew install cloudflared" },
  devices: [],
  online: 0,
  pending: 0,
  acknowledged: false,
  permissions: ["read", "send", "answer", "stop"],
  idle_off_hours: 8,
  web_app: true,
};

test("the switch line says what the state means", () => {
  assert.equal(stateLine(base), "Off. Your phone can reach this computer only while this is on.");
  assert.equal(stateLine({ ...base, state: "on", online: 2 }), "On, 2 devices connected. Turns off after 8 hours without use, and when Octo quits.");
  assert.equal(stateLine({ ...base, state: "on", idle_off_hours: 0 }), "On, no device connected. Turns off when Octo quits.");
  assert.equal(
    stateLine({ ...base, state: "error", error: { code: "tunnel_failed", message: "The tunnel to Cloudflare could not be opened." } }),
    "The tunnel to Cloudflare could not be opened.",
  );
});

test("the pairing code counts down to expired", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(countdown("2026-11-14T12:05:00Z", now), "5:00");
  assert.equal(countdown("2026-11-14T12:00:09Z", now), "0:09");
  assert.equal(countdown("2026-11-14T11:59:00Z", now), "expired");
});

test("a device's line", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const d: RemoteDevice = { id: "d", name: "iPhone", status: "pending", read_only: false, paired_at: "2026-11-14T12:00:00Z", online: false };
  assert.equal(deviceLine(d, now), "Paired just now. Waiting for you to allow it.");
  assert.equal(deviceLine({ ...d, status: "active", online: true }, now), "Paired just now · connected now");
  assert.equal(deviceLine({ ...d, status: "active", read_only: true, last_seen: "2026-11-14T10:00:00Z" }, now), "Paired just now · last seen 2h ago");
});

test("the status bar item", () => {
  assert.equal(indicatorText({ state: "off", online: 0, pending: 0 }), null);
  assert.equal(indicatorText({ state: "on", online: 0, pending: 0 }), "Remote");
  assert.equal(indicatorText({ state: "on", online: 2, pending: 0 }), "Remote · 2");
  assert.equal(indicatorText({ state: "on", online: 1, pending: 1 }), "Remote · allow?");
  assert.equal(indicatorText({ state: "error", online: 0, pending: 0 }), "Remote access stopped");
});
