/**
 * A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10 (up to 213 bytes), the
 * mask with the lowest penalty. Enough for a remote-access pairing link (`https://<words>.trycloudflare.com/#pair=CODE`,
 * about 70 bytes). Dependency-free by choice (no new package for one screen). `qr.test.ts` checks the Reed-Solomon
 * codewords, format and version bits against the standard's published values and reads every code back (unmask,
 * de-interleave, syndromes, payload). Follows the structure of Project Nayuki's reference encoder.
 */

/** Per version (index = version): EC codewords per block, then [blocks, data codewords per block] groups (level M). */
const BLOCKS_M: readonly (readonly [number, readonly (readonly [number, number])[]])[] = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [
    22,
    [
      [2, 38],
      [2, 39],
    ],
  ],
  [
    22,
    [
      [3, 36],
      [2, 37],
    ],
  ],
  [
    26,
    [
      [4, 43],
      [1, 44],
    ],
  ],
];

const ALIGN: readonly (readonly number[])[] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const QR_MAX_BYTES = 213;

/** A QR code: `size` × `size` modules, `dark(x, y)` with x the column and y the row. */
export type QrCode = { size: number; version: number; mask: number; dark(x: number, y: number): boolean };

function dataCapacity(version: number): number {
  const spec = BLOCKS_M[version];
  if (!spec) return 0;
  return spec[1].reduce((n, [blocks, per]) => n + blocks * per, 0);
}

/** Encodes text (UTF-8) as a QR code; throws when it does not fit version 10-M. */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(1, opts.minVersion ?? 1);
  for (; version <= 10; version++) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(version) * 8) break;
  }
  if (version > 10) throw new Error(`QR: ${String(bytes.length)} bytes do not fit (at most ${String(QR_MAX_BYTES)})`);
  const data = encodeData(bytes, version);
  const codewords = addEcAndInterleave(data, version);
  const m = new Matrix(version);
  m.drawFunctionPatterns();
  m.drawCodewords(codewords);
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let k = 0; k < 8; k++) {
      m.applyMask(k);
      m.drawFormat(k);
      const p = m.penalty();
      if (p < best) {
        best = p;
        mask = k;
      }
      m.applyMask(k); // undo (XOR)
    }
  }
  m.applyMask(mask);
  m.drawFormat(mask);
  const grid = m.modules;
  return { size: m.size, version, mask, dark: (x, y) => grid[y]?.[x] === true };
}

function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCapacity(version) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0);
    out.push(b);
  }
  return out;
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0));

function rsGenerator(degree: number): number[] {
  // Coefficients from the highest power down, the leading 1 dropped.
  const g = new Array<number>(degree).fill(0);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = mul(g[j] ?? 0, root) ^ (g[j + 1] ?? 0);
    }
    root = mul(root, 2);
  }
  return g;
}

/** The Reed-Solomon error-correction codewords of one block (exported for the tests). */
export function rsEcc(data: readonly number[], ecLen: number): number[] {
  return rsRemainder(data, rsGenerator(ecLen));
}

/** The 15 format bits for level M and a mask (exported for the tests). */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up; exported for the tests). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** Block layout of a version at level M: EC codewords per block and the data length of each block (for the tests). */
export function blockLayout(version: number): { ecLen: number; blocks: number[] } {
  const spec = BLOCKS_M[version];
  if (!spec) throw new Error("QR: bad version");
  return { ecLen: spec[0], blocks: spec[1].flatMap(([n, per]) => new Array<number>(n).fill(per)) };
}

function rsRemainder(data: readonly number[], gen: readonly number[]): number[] {
  const r = new Array<number>(gen.length).fill(0);
  for (const b of data) {
    const factor = b ^ (r.shift() ?? 0);
    r.push(0);
    for (let i = 0; i < gen.length; i++) r[i] = (r[i] ?? 0) ^ mul(gen[i] ?? 0, factor);
  }
  return r;
}

function addEcAndInterleave(data: readonly number[], version: number): number[] {
  const spec = BLOCKS_M[version];
  if (!spec) throw new Error("QR: bad version");
  const [ecLen, groups] = spec;
  const gen = rsGenerator(ecLen);
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let k = 0;
  for (const [count, per] of groups) {
    for (let b = 0; b < count; b++) {
      const block = data.slice(k, k + per);
      k += per;
      blocks.push(block);
      ecs.push(rsRemainder(block, gen));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i] ?? 0);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i] ?? 0);
  return out;
}

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly fn: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const frow = this.fn[y];
    if (!row || !frow || x < 0 || x >= this.size) return;
    row[x] = dark;
    frow[x] = true;
  }

  drawFunctionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(s - 4, 3);
    this.finder(3, s - 4);
    const pos = ALIGN[this.version] ?? [];
    const last = pos.length - 1;
    pos.forEach((px, i) =>
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.drawFormat(0); // reserves the format area; drawn again with the real mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
      }
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }

  drawCodewords(data: readonly number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          const row = this.modules[y];
          if (row && !this.fn[y]?.[x] && i < data.length * 8) {
            row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      const row = this.modules[y];
      if (!row) continue;
      for (let x = 0; x < this.size; x++) {
        if (this.fn[y]?.[x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (invert) row[x] = !row[x];
      }
    }
  }

  /** The standard penalty (N1 runs, N2 blocks, N3 finder-like patterns, N4 balance); lower is better. */
  penalty(): number {
    const s = this.size;
    const at = (x: number, y: number) => this.modules[y]?.[x] === true;
    let p = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < s; a++) {
        let run = 1;
        let line = "";
        for (let b = 0; b < s; b++) {
          const v = pass === 0 ? at(b, a) : at(a, b);
          line += v ? "1" : "0";
          if (b > 0) {
            const prev = pass === 0 ? at(b - 1, a) : at(a, b - 1);
            if (v === prev) {
              run++;
              if (run === 5) p += 3;
              else if (run > 5) p += 1;
            } else run = 1;
          }
        }
        for (const pat of ["00001011101", "10111010000"]) {
          for (let k = line.indexOf(pat); k >= 0; k = line.indexOf(pat, k + 1)) p += 40;
        }
      }
    }
    let dark = 0;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = at(x, y);
        if (v) dark++;
        if (x < s - 1 && y < s - 1 && v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) p += 3;
      }
    }
    const total = s * s;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return p;
  }
}
