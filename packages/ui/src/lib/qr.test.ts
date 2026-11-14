import assert from "node:assert/strict";
import test from "node:test";
import { blockLayout, encodeQr, formatBits, rsEcc, versionBits, type QrCode } from "./qr";

test("Reed-Solomon codewords match the standard's worked example (version 1-M, 01234567)", () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(rsEcc(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test("format bits for level M match the published table", () => {
  const table = [
    "101010000010010",
    "101000100100101",
    "101111001111100",
    "101101101001011",
    "100010111111001",
    "100000011001110",
    "100111110010111",
    "100101010100000",
  ];
  table.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, "0"), bits));
});

test("version bits match the published table", () => {
  assert.equal(versionBits(7).toString(2).padStart(18, "0"), "000111110010010100");
  assert.equal(versionBits(10).toString(2).padStart(18, "0"), "001010010011010011");
});

// ---- An independent reader: function areas, format, unmask, zigzag, de-interleave, syndromes, payload. ----

const ALIGN_CENTRES: Record<number, number[]> = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function isFunction(x: number, y: number, size: number, version: number): boolean {
  if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true;
  if (x === 6 || y === 6) return true;
  if (version >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6))) return true;
  const c = ALIGN_CENTRES[version] ?? [];
  for (const cx of c)
    for (const cy of c) {
      const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === c[c.length - 1]) || (cx === c[c.length - 1] && cy === 6);
      if (!corner && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
  return false;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const EXP: number[] = [];
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP.push(v);
    v = v << 1;
    if (v > 255) v ^= 0x11d;
  }
}
function gmul(a: number, b: number): number {
  let r = 0;
  for (; b > 0; b >>= 1, a = a & 0x80 ? ((a << 1) ^ 0x11d) & 0xff : a << 1) if (b & 1) r ^= a;
  return r;
}

function read(qr: QrCode): string {
  const { size, version } = qr;
  assert.equal(size, version * 4 + 17);
  // Finder corners, timing, dark module.
  for (const [x, y] of [
    [0, 0],
    [size - 1, 0],
    [0, size - 1],
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    assert.ok(qr.dark(x, y), `finder at ${String(x)},${String(y)}`);
  for (let i = 8; i < size - 8; i++) assert.equal(qr.dark(i, 6), i % 2 === 0, "timing");
  assert.ok(qr.dark(8, size - 8), "dark module");
  // Format (first copy) names the mask.
  let fmt = 0;
  const fpos: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  fpos.forEach(([x, y], i) => (fmt |= (qr.dark(x, y) ? 1 : 0) << i));
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits(m) === fmt);
  assert.equal(mask, qr.mask, "format bits");
  const unmask = MASKS[qr.mask] ?? MASKS[0];
  // Zigzag read.
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction(x, y, size, version)) bits.push(qr.dark(x, y) !== unmask?.(x, y) ? 1 : 0);
      }
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave and check every block's syndromes.
  const { ecLen, blocks } = blockLayout(version);
  const longest = Math.max(...blocks);
  const data: number[][] = blocks.map(() => []);
  let k = 0;
  for (let i = 0; i < longest; i++) blocks.forEach((len, b) => i < len && data[b]?.push(bytes[k++] ?? -1));
  const ec: number[][] = blocks.map(() => []);
  for (let i = 0; i < ecLen; i++) blocks.forEach((_len, b) => ec[b]?.push(bytes[k++] ?? -1));
  blocks.forEach((_len, b) => {
    const word = [...(data[b] ?? []), ...(ec[b] ?? [])];
    for (let i = 0; i < ecLen; i++) {
      const s = word.reduce((acc, c) => gmul(acc, EXP[i] ?? 0) ^ c, 0);
      assert.equal(s, 0, `syndrome ${String(i)} of block ${String(b)}`);
    }
  });
  // Payload: byte mode, count, bytes.
  const flat = data.flat();
  const bit = (i: number) => ((flat[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1;
  const take = (from: number, n: number) => Array.from({ length: n }, (_, i) => bit(from + i)).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(0, 4), 0b0100, "byte mode");
  const countBits = version < 10 ? 8 : 16;
  const n = take(4, countBits);
  const out = Array.from({ length: n }, (_, i) => take(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(out));
}

test("pairing links read back exactly, at every size the encoder offers, with every mask", () => {
  const texts = [
    "https://seasonal-deck-organisms-sf.trycloudflare.com/#pair=ABCD2345",
    "https://fake-quick-tunnel-1.trycloudflare.com/#pair=10N7WA86",
    "hi",
    "Ünïcødé — 漢字",
    "x".repeat(150),
    "y".repeat(213),
  ];
  for (const t of texts) {
    const qr = encodeQr(t);
    assert.equal(read(qr), t);
    for (let m = 0; m < 8; m++) assert.equal(read(encodeQr(t, { mask: m })), t, `mask ${String(m)}`);
  }
  for (let v = 1; v <= 10; v++) assert.equal(read(encodeQr("Octo", { minVersion: v })), "Octo", `version ${String(v)}`);
});

test("the smallest version that fits is chosen; too much text is refused", () => {
  assert.equal(encodeQr("x".repeat(14)).version, 1);
  assert.equal(encodeQr("x".repeat(15)).version, 2);
  assert.equal(encodeQr("https://seasonal-deck-organisms-sf.trycloudflare.com/#pair=ABCD2345").version, 5);
  assert.throws(() => encodeQr("z".repeat(214)));
});
