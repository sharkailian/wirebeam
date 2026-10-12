/**
 * qrbuild.mjs — a from-scratch QR *symbol builder* used as a second
 * independent implementation for two purposes:
 *   1. reproducing published ISO/IEC 18004 reference symbols (numeric and
 *      alphanumeric mode, which qr.ts does not implement) so that the
 *      mask-selection penalty can be checked against published masks;
 *   2. rebuilding qr.ts's own symbols from their decoded codewords, so that
 *      placement, interleaving, masking and format-info generation can be
 *      compared module-for-module against an implementation that shares no
 *      code with qr.ts.
 *
 * It shares only the GF(256) primitives with qrdec.mjs.
 */
import {
  alignmentCenters,
  formatBitsOf,
  functionMap,
  gfAlpha,
  gfMul,
  maskBitFn,
  versionSize,
} from './qrdec.mjs';

const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Generator polynomial of degree n: prod (x - alpha^i), i = 0..n-1. */
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const root = gfAlpha(i);
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of data * x^degree modulo the generator. */
export function rsRemainder(data, gen) {
  const degree = gen.length - 1;
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    for (let i = 0; i < degree - 1; i++) rem[i] = rem[i + 1] ^ gfMul(gen[i + 1], factor);
    rem[degree - 1] = gfMul(gen[degree], factor);
  }
  return rem;
}

/** Interleave data + EC codewords of a block set (inverse of deinterleave). */
export function interleaveBlocks(blocks, dataLens, ecLen) {
  const out = [];
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < dataLens[b]) out.push(blocks[b][i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < blocks.length; b++) out.push(blocks[b][dataLens[b] + i]);
  }
  return out;
}

/** Split data codewords into blocks, append EC, and interleave. */
export function addEccAndInterleave(data, numBlocks, ecLen) {
  const total = data.length + numBlocks * ecLen;
  const shortBlockLen = Math.floor(total / numBlocks);
  const numShort = numBlocks - (total % numBlocks);
  const shortDataLen = shortBlockLen - ecLen;
  const dataLens = [];
  for (let b = 0; b < numBlocks; b++) dataLens.push(shortDataLen + (b < numShort ? 0 : 1));
  const gen = rsGenerator(ecLen);
  const blocks = [];
  let off = 0;
  for (let b = 0; b < numBlocks; b++) {
    const d = data.slice(off, off + dataLens[b]);
    off += dataLens[b];
    blocks.push([...d, ...rsRemainder(d, gen)]);
  }
  if (off !== data.length) throw new Error('block split mismatch');
  return interleaveBlocks(blocks, dataLens, ecLen);
}

/** Draw timing, finders/separators, alignment, version-info blocks.
 *  Order matters: the timing pattern is drawn first and the finder patterns
 *  are then drawn over it, because the finder's edge column/row (x=6 / y=6)
 *  must win over the alternating timing modules inside the finder areas. */
function drawFunctionPatterns(version, m) {
  const size = versionSize(version);
  const set = (x, y, v) => {
    m[y][x] = v;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const ac = alignmentCenters(version);
  for (const cy of ac) {
    for (const cx of ac) {
      const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  if (version >= 7) {
    // BCH(18,6) version information, 0x1f25.
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
    const bits = ((version << 12) | (rem & 0xfff)) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
}

/** Place the interleaved codeword bits in zigzag order (unmasked). */
function placeCodewords(version, m, codewords) {
  const size = versionSize(version);
  const fn = functionMap(version);
  let i = 0;
  const totalBits = codewords.length * 8;
  let pairIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = pairIndex % 2 === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (fn[y][x]) continue;
        if (i < totalBits) {
          m[y][x] = ((codewords[i >> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        } else {
          m[y][x] = false; // remainder bits are zero
        }
      }
    }
    pairIndex++;
  }
  return i;
}

/** Write both format-information copies and the always-dark module. */
function writeFormatBits(version, ec, mask, m) {
  const size = versionSize(version);
  const word = formatBitsOf((EC_BITS[ec] << 3) | mask);
  const bitAt = (i) => ((word >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) m[i][8] = bitAt(i);
  m[7][8] = bitAt(6);
  m[8][8] = bitAt(7);
  m[8][7] = bitAt(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bitAt(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bitAt(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bitAt(i);
  m[size - 8][8] = true;
}

/** Full symbol: function patterns, data, mask, format info. */
export function buildSymbol(version, ec, interleaved, mask) {
  const size = versionSize(version);
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(version, m);
  const placed = placeCodewords(version, m, interleaved);
  const fn = functionMap(version);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y][x] && maskBitFn(mask, x, y)) m[y][x] = !m[y][x];
    }
  }
  writeFormatBits(version, ec, mask, m);
  return { modules: m, placedBits: placed, size };
}

/** Unmasked matrix (data bits placed, no mask, no format bits). */
export function buildUnmasked(version, interleaved) {
  const size = versionSize(version);
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(version, m);
  placeCodewords(version, m, interleaved);
  return m;
}

/** Apply a mask + format bits to an already-built unmasked matrix. */
export function applyMaskTo(version, ec, mask, unmasked) {
  const size = versionSize(version);
  const m = unmasked.map((r) => r.slice());
  const fn = functionMap(version);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y][x] && maskBitFn(mask, x, y)) m[y][x] = !m[y][x];
    }
  }
  writeFormatBits(version, ec, mask, m);
  return m;
}

// ---------------------------------------------------------------------------
// Data codeword assembly for the modes qr.ts does not implement
// ---------------------------------------------------------------------------

class BitBuf {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function finish(bb, dataCodewords) {
  const capacity = dataCodewords * 8;
  if (bb.bits.length > capacity) throw new Error(`payload ${bb.bits.length} bits > capacity ${capacity}`);
  const term = Math.min(4, capacity - bb.bits.length);
  bb.push(0, term);
  bb.push(0, (8 - (bb.bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j];
    out.push(v);
  }
  let pad = 0xec;
  while (out.length < dataCodewords) {
    out.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return out;
}

const countBitsFor = (version, mode) => {
  // byte: 8/16; numeric: 10/12/14; alphanumeric: 9/11/13
  const g = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 'numeric') return [10, 12, 14][g];
  if (mode === 'alphanumeric') return [9, 11, 13][g];
  return [8, 16, 16][g];
};

/** Numeric mode (0001) data codewords. */
export function numericCodewords(digits, version, dataCodewords) {
  const bb = new BitBuf();
  bb.push(0b0001, 4);
  bb.push(digits.length, countBitsFor(version, 'numeric'));
  for (let i = 0; i < digits.length; i += 3) {
    const chunk = digits.slice(i, i + 3);
    const widths = { 1: 4, 2: 7, 3: 10 };
    bb.push(parseInt(chunk, 10), widths[chunk.length]);
  }
  return finish(bb, dataCodewords);
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Alphanumeric mode (0010) data codewords. */
export function alphanumericCodewords(text, version, dataCodewords) {
  const bb = new BitBuf();
  bb.push(0b0010, 4);
  bb.push(text.length, countBitsFor(version, 'alphanumeric'));
  for (let i = 0; i < text.length; i += 2) {
    const a = ALNUM.indexOf(text[i]);
    if (a < 0) throw new Error(`not alphanumeric: ${text[i]}`);
    if (i + 1 < text.length) {
      const b = ALNUM.indexOf(text[i + 1]);
      if (b < 0) throw new Error(`not alphanumeric: ${text[i + 1]}`);
      bb.push(a * 45 + b, 11);
    } else {
      bb.push(a, 6);
    }
  }
  return finish(bb, dataCodewords);
}
