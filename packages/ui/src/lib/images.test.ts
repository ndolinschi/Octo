import assert from "node:assert/strict";
import test from "node:test";
import { fitSize, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, imageSize, planImage, redrawType, room } from "./images";

test("an image within 2048 px and 5 MB goes as it is", () => {
  assert.equal(planImage({ type: "image/png", bytes: 1_000_000, width: 2048, height: 1000 }), "keep");
  assert.deepEqual(fitSize(2048, 1000), { width: 2048, height: 1000, scaled: false });
});

test("a larger image is scaled on its long side, shape kept", () => {
  assert.deepEqual(fitSize(4096, 2048), { width: 2048, height: 1024, scaled: true });
  assert.deepEqual(fitSize(1000, 3000), { width: 683, height: 2048, scaled: true });
  assert.equal(planImage({ type: "image/jpeg", bytes: 10, width: 5000, height: 10 }), "redraw");
});

test("too many bytes or an unsupported type is drawn again", () => {
  assert.equal(planImage({ type: "image/jpeg", bytes: IMAGE_MAX_BYTES + 1, width: 100, height: 100 }), "redraw");
  assert.equal(planImage({ type: "image/bmp", bytes: 10, width: 10, height: 10 }), "redraw");
  assert.equal(redrawType("image/png"), "image/png");
  assert.equal(redrawType("image/bmp"), "image/jpeg");
});

test("at most eight per message", () => {
  assert.deepEqual(room(0, 3), { take: 3, over: 0 });
  assert.deepEqual(room(6, 5), { take: 2, over: 3 });
  assert.deepEqual(room(IMAGE_MAX_COUNT, 1), { take: 0, over: 1 });
});

test("sizes read as KB or MB", () => {
  assert.equal(imageSize(480 * 1024), "480 KB");
  assert.equal(imageSize(3.2 * 1024 * 1024), "3.2 MB");
});
