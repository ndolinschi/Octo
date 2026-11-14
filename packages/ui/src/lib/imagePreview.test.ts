import assert from "node:assert/strict";
import test from "node:test";
import { fileSizeLabel, imageDataUrl, imageType, isSvg, pixelSizeLabel } from "./imagePreview";

test("imageType knows the previewable formats by extension, case-insensitively", () => {
  assert.equal(imageType("atlas-web/public/logo.png"), "image/png");
  assert.equal(imageType("a/B.JPG"), "image/jpeg");
  assert.equal(imageType("x.jpeg"), "image/jpeg");
  assert.equal(imageType("x.gif"), "image/gif");
  assert.equal(imageType("x.webp"), "image/webp");
  assert.equal(imageType("favicon.ico"), "image/x-icon");
  assert.equal(imageType("x.avif"), "image/avif");
  assert.equal(imageType("mark.svg"), "image/svg+xml");
  assert.equal(imageType("notes.txt"), null);
  assert.equal(imageType(".png"), null);
  assert.equal(imageType("dir.png/readme"), null);
});

test("isSvg and the data URL", () => {
  assert.equal(isSvg("a/b.SVG"), true);
  assert.equal(isSvg("a/b.png"), false);
  assert.equal(imageDataUrl("m.svg", "PHN2Zy8+"), "data:image/svg+xml;base64,PHN2Zy8+");
});

test("size labels", () => {
  assert.equal(fileSizeLabel(1), "1 byte");
  assert.equal(fileSizeLabel(357), "357 bytes");
  assert.equal(fileSizeLabel(18_342), "18 KB");
  assert.equal(fileSizeLabel(3_400_000), "3.2 MB");
  assert.equal(fileSizeLabel(2 << 20), "2 MB");
  assert.equal(pixelSizeLabel(120, 80), "120 × 80 px");
  assert.equal(pixelSizeLabel(0, 0), "");
});
