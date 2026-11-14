import assert from "node:assert/strict";
import test from "node:test";
import { clockNow, onClockOffset, setClockOffset } from "./clock";

test("clockNow follows the service's clock by the offset, and falls back to the local clock", () => {
  setClockOffset(-3 * 86_400_000);
  const shifted = clockNow();
  assert.ok(Math.abs(shifted - (Date.now() - 3 * 86_400_000)) < 1000);
  setClockOffset(Number.NaN);
  assert.ok(Math.abs(clockNow() - Date.now()) < 1000);
  setClockOffset(0);
});

test("a changed offset tells the clocks on screen; the same offset again does not", () => {
  let told = 0;
  const off = onClockOffset(() => (told += 1));
  setClockOffset(60_000);
  setClockOffset(60_000);
  assert.equal(told, 1);
  off();
  setClockOffset(0);
  assert.equal(told, 1);
});
