/**
 * qr.ts — self-contained QR Code (ISO/IEC 18004) encoder plus SVG and
 * terminal renderers.
 *
 * Properties:
 *  - Zero dependencies and zero imports (Node's global `TextEncoder` is used
 *    for UTF-8); everything is pure synchronous computation.
 *  - Runs directly under Node 24 native type stripping: no `enum`, no
 *    `namespace`, no parameter properties, no decorators, no runtime imports.
 *  - Byte mode (0100) with UTF-8 bytes; the smallest fitting version is used.
 *  - Versions 1..40 at all four error-correction levels, with the full
 *    standard block-structure / EC-codeword tables.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

// ---------------------------------------------------------------------------
// Static tables (ISO/IEC 18004 tables 9, 13-22, 25, D.1)
// ---------------------------------------------------------------------------

const EC_LEVELS: readonly EcLevel[] = ['L', 'M', 'Q', 'H'];

/** 2-bit error-correction indicators embedded in the format information. */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Number of error-correction codewords per block, indexed
 * `[levelIndex][version]` (index 0 is an unused placeholder).
 */
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // v:  0   1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

/**
 * Number of error-correction blocks, indexed `[levelIndex][version]`
 * (index 0 is an unused placeholder).
 */
const NUM_EC_BLOCKS: readonly (readonly number[])[] = [
  // v:  0  1  2  3  4  5  6  7  8  9 10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

/** Mask applied to the BCH-encoded format information. */
const FORMAT_INFO_MASK = 0x5412;

/** Generator polynomial of the (15, 5) BCH code used by format information. */
const FORMAT_INFO_GENERATOR = 0x537;

/** Generator polynomial of the (18, 6) BCH code used by version information. */
const VERSION_INFO_GENERATOR = 0x1f25;

/** Primitive polynomial of GF(256) used by QR Reed-Solomon codes: x^8+x^4+x^3+x^2+1. */
const GF_PRIMITIVE = 0x11d;

// ---------------------------------------------------------------------------
// Version geometry helpers
// ---------------------------------------------------------------------------

/**
 * Total number of data modules (function patterns excluded) for a version,
 * i.e. `totalCodewords * 8` plus the 0..7 remainder bits.
 */
function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // two 3x6 version-information blocks
  }
  return result;
}

/** Centre coordinates of the alignment patterns for a version (ascending). */
function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const positions: number[] = [6];
  for (let pos = version * 4 + 10; positions.length < numAlign; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

/** Character-count indicator width for byte mode (8/16/16 bits). */
function byteCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Block layout (groups 1 and 2) of a version at one EC level. */
interface BlockPlan {
  readonly version: number;
  readonly ec: EcLevel;
  /** Total codewords (data + EC) in the symbol. */
  readonly totalCodewords: number;
  readonly ecCodewordsPerBlock: number;
  readonly numBlocks: number;
  /** Total codewords in a group-1 (shorter) block. */
  readonly shortBlockLen: number;
  /** Number of group-1 blocks; the remaining blocks hold one more codeword. */
  readonly numShortBlocks: number;
  /** Total data codewords available for the whole symbol. */
  readonly dataCodewords: number;
}

function levelIndex(ec: EcLevel): number {
  const idx = EC_LEVELS.indexOf(ec);
  if (idx < 0) throw new RangeError(`Unknown EC level: ${String(ec)}`);
  return idx;
}

function getBlockPlan(version: number, ec: EcLevel): BlockPlan {
  const li = levelIndex(ec);
  const ecCodewordsPerBlock = ECC_CODEWORDS_PER_BLOCK[li][version];
  const numBlocks = NUM_EC_BLOCKS[li][version];
  const totalCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks);
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const dataCodewords = totalCodewords - ecCodewordsPerBlock * numBlocks;
  const shortDataLen = shortBlockLen - ecCodewordsPerBlock;
  if (shortDataLen < 1) {
    throw new Error(`Internal error: invalid block structure for version ${version} EC ${ec}`);
  }
  return {
    version,
    ec,
    totalCodewords,
    ecCodewordsPerBlock,
    numBlocks,
    shortBlockLen,
    numShortBlocks,
    dataCodewords,
  };
}

/** Total data codewords for a version / EC level. */
function getDataCodewords(version: number, ec: EcLevel): number {
  return getBlockPlan(version, ec).dataCodewords;
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256)
// ---------------------------------------------------------------------------

/** Antilog table: GF_EXP[i] = alpha^i, doubled so products never wrap. */
const GF_EXP: number[] = new Array<number>(512).fill(0);
/** Log table: GF_LOG[GF_EXP[i]] = i. */
const GF_LOG: number[] = new Array<number>(256).fill(0);

function initGaloisField(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
initGaloisField();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Reed-Solomon generator polynomial of the given degree:
 * `(x - a^0)(x - a^1)...(x - a^(degree-1))`, coefficients from the highest
 * power of x down to the constant term (leading coefficient is 1).
 */
function rsGeneratorPoly(degree: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i];
    const next: number[] = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // multiply by x
      next[j + 1] ^= gfMul(poly[j], root); // multiply by a^i
    }
    poly = next;
  }
  return poly;
}

/** Remainder of dividing `data * x^degree` by the generator polynomial. */
function rsComputeRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const degree = generator.length - 1;
  const rem: number[] = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    for (let i = 0; i < degree - 1; i++) {
      rem[i] = rem[i + 1] ^ gfMul(generator[i + 1], factor);
    }
    rem[degree - 1] = gfMul(generator[degree], factor);
  }
  return rem;
}

/**
 * Splits the data codewords into blocks, appends the EC codewords of every
 * block and interleaves both parts as required by the standard (short group-1
 * blocks simply contribute no codeword at the last interleaving round).
 */
function addEccAndInterleave(data: readonly number[], plan: BlockPlan): number[] {
  const generator = rsGeneratorPoly(plan.ecCodewordsPerBlock);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < plan.numBlocks; b++) {
    const len = plan.shortBlockLen - plan.ecCodewordsPerBlock + (b < plan.numShortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsComputeRemainder(block, generator));
  }
  if (offset !== data.length) {
    throw new Error('Internal error: block split does not consume all data codewords');
  }
  const result: number[] = [];
  const maxDataLen = plan.shortBlockLen - plan.ecCodewordsPerBlock + 1;
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < plan.ecCodewordsPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bit stream assembly
// ---------------------------------------------------------------------------

/** Minimal append-only bit buffer (most-significant bit first). */
class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

/** Builds the padded data codewords for byte mode at a fixed version. */
function buildDataCodewords(bytes: readonly number[], version: number, ec: EcLevel): number[] {
  const plan = getBlockPlan(version, ec);
  const capacityBits = plan.dataCodewords * 8;
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode indicator
  bb.push(bytes.length, byteCountBits(version)); // character count
  for (const b of bytes) bb.push(b, 8);
  if (bb.length > capacityBits) {
    throw new Error(`QR data too long for version ${version} at EC level ${ec}`);
  }
  // Terminator: up to four zero bits.
  const terminator = Math.min(4, capacityBits - bb.length);
  bb.push(0, terminator);
  // Pad to a byte boundary.
  bb.push(0, (8 - (bb.length % 8)) % 8);
  // Alternating pad codewords.
  const codewords: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < plan.dataCodewords; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

// ---------------------------------------------------------------------------
// Symbol matrix
// ---------------------------------------------------------------------------

/** Penalty weights of the four data-masking rules (ISO/IEC 18004 8.8.2). */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** A QR symbol under construction: function patterns, data, masking. */
class QrSymbol {
  readonly version: number;
  readonly size: number;
  readonly ec: EcLevel;
  readonly modules: boolean[][];
  mask = 0;
  private readonly isFunction: boolean[][];

  constructor(version: number, codewords: readonly number[], ec: EcLevel) {
    this.version = version;
    this.ec = ec;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (let y = 0; y < this.size; y++) {
      this.modules.push(new Array<boolean>(this.size).fill(false));
      this.isFunction.push(new Array<boolean>(this.size).fill(false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);
    this.mask = this.chooseBestMask();
    this.applyMask(this.mask);
    this.drawFormatBits(this.mask);
  }

  private setFunctionModule(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  /** Finder patterns plus their separators, drawn as 9x9 areas. */
  private drawFinderPattern(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunctionModule(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFunctionPatterns(): void {
    const size = this.size;
    // Timing patterns.
    for (let i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    // Finder patterns and separators.
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);
    // Alignment patterns (skipping the three finder corners).
    const positions = getAlignmentPatternPositions(this.version);
    for (const cy of positions) {
      for (const cx of positions) {
        const onFinderCorner =
          (cx === 6 && cy === 6) ||
          (cx === 6 && cy === size - 7) ||
          (cx === size - 7 && cy === 6);
        if (!onFinderCorner) this.drawAlignmentPattern(cx, cy);
      }
    }
    // Reserve the format-information areas with dummy (mask 0) content and the
    // version-information blocks; the real values are written later.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  /** Format information: 5 data bits, BCH(15,5), XOR 0x5412 (spec 8.9). */
  private drawFormatBits(mask: number): void {
    const data = (EC_FORMAT_BITS[this.ec] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_INFO_GENERATOR);
    const bits = ((data << 10) | rem) ^ FORMAT_INFO_MASK; // 15 bits

    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    // Second copy, split between the other two finders.
    const size = this.size;
    for (let i = 0; i < 8; i++) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, size - 8, true); // always-dark module
  }

  /** Version information: 6 data bits, BCH(18,6), for versions >= 7 (spec 8.10). */
  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * VERSION_INFO_GENERATOR);
    const bits = (this.version << 12) | rem; // 18 bits
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  /** Zigzag placement of the interleaved codewords (spec 8.7.3). */
  private drawCodewords(codewords: readonly number[]): void {
    const size = this.size;
    let i = 0; // bit index into `codewords`
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = getBit(codewords[i >> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** Applies mask XOR to every non-function module (involution). */
  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        if (maskApplies(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Evaluates all eight masks and returns the one with the lowest penalty. */
  private chooseBestMask(): number {
    let best = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.getPenaltyScore();
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = mask;
      }
      this.applyMask(mask); // undo (XOR is an involution)
    }
    return best;
  }

  /** The four masking penalty rules of spec 8.8.2. */
  private getPenaltyScore(): number {
    const size = this.size;
    const modules = this.modules;
    let result = 0;

    // Rule 1: runs of five or more same-coloured modules in a row/column.
    for (let y = 0; y < size; y++) {
      let runColor = modules[y][0];
      let runLen = 1;
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = modules[0][x];
      let runLen = 1;
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks of the same colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 3: 1:1:3:1:1 finder-like pattern with four light modules on a side.
    // The window is clamped at the symbol border: the mandatory 4-module quiet
    // zone means a pattern touching the border is still flanked by light.
    const isLightRun = (get: (i: number) => boolean, from: number, to: number): boolean => {
      const a = Math.max(from, 0);
      const b = Math.min(to, size);
      for (let i = a; i < b; i++) if (get(i)) return false;
      return true;
    };
    for (let y = 0; y < size; y++) {
      const get = (i: number): boolean => modules[y][i];
      for (let x = 0; x + 6 < size; x++) {
        if (
          get(x) && !get(x + 1) && get(x + 2) && get(x + 3) && get(x + 4) && !get(x + 5) && get(x + 6) &&
          (isLightRun(get, x - 4, x) || isLightRun(get, x + 7, x + 11))
        ) {
          result += PENALTY_N3;
        }
      }
    }
    for (let x = 0; x < size; x++) {
      const get = (i: number): boolean => modules[i][x];
      for (let y = 0; y + 6 < size; y++) {
        if (
          get(y) && !get(y + 1) && get(y + 2) && get(y + 3) && get(y + 4) && !get(y + 5) && get(y + 6) &&
          (isLightRun(get, y - 4, y) || isLightRun(get, y + 7, y + 11))
        ) {
          result += PENALTY_N3;
        }
      }
    }

    // Rule 4: deviation of the dark-module share from 50%, in 5% steps.
    // k = floor(|dark% - 50| / 5), penalty = 10 * k; the integer form below
    // avoids floating-point trouble exactly at the 5% boundaries.
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    }
    const total = size * size;
    const steps = Math.floor((Math.abs(dark * 2 - total) * 10) / total);
    result += steps * PENALTY_N4;

    return result;
  }
}

/** Bit `i` of `value`, counted from the least-significant bit. */
function getBit(value: number, i: number): boolean {
  return ((value >>> i) & 1) !== 0;
}

/** True when mask `mask` inverts the module at column `x`, row `y`. */
function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError(`Invalid mask pattern: ${mask}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Smallest version >= `minVersion` whose byte-mode capacity fits `byteLength`. */
function pickVersion(byteLength: number, ec: EcLevel, minVersion: number): number {
  for (let version = minVersion; version <= 40; version++) {
    const neededBits = 4 + byteCountBits(version) + byteLength * 8;
    if (neededBits <= getDataCodewords(version, ec) * 8) return version;
  }
  throw new Error(`QR data too long for version 40 at EC level ${ec}`);
}

function validateEc(ec: EcLevel): EcLevel {
  if (!EC_LEVELS.includes(ec)) throw new RangeError(`Unknown EC level: ${String(ec)}`);
  return ec;
}

/**
 * Encode text (UTF-8, byte mode) into a QR matrix.
 * Returns `{ size, modules }` where `modules[y][x] === true` means a dark module.
 */
export function encodeQr(
  text: string,
  opts?: { ec?: EcLevel; minVersion?: number },
): { size: number; modules: boolean[][] } {
  const ec = validateEc(opts?.ec ?? 'M');
  const minVersion = opts?.minVersion ?? 1;
  if (!Number.isInteger(minVersion) || minVersion < 1 || minVersion > 40) {
    throw new RangeError(`minVersion must be an integer in 1..40, got ${String(minVersion)}`);
  }
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length, ec, minVersion);
  const dataCodewords = buildDataCodewords(bytes, version, ec);
  const plan = getBlockPlan(version, ec);
  const allCodewords = addEccAndInterleave(dataCodewords, plan);
  const symbol = new QrSymbol(version, allCodewords, ec);
  return { size: symbol.size, modules: symbol.modules };
}

/**
 * Render a QR code as a compact SVG string (1 module = 1 unit, quiet zone of 4
 * modules by default).
 */
export function toSvg(
  text: string,
  opts?: { ec?: EcLevel; scale?: number; margin?: number },
): string {
  const ec = validateEc(opts?.ec ?? 'M');
  const scale = opts?.scale ?? 1;
  const margin = opts?.margin ?? 4;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`scale must be a positive number, got ${String(scale)}`);
  }
  if (!Number.isInteger(margin) || margin < 0) {
    throw new RangeError(`margin must be a non-negative integer, got ${String(margin)}`);
  }
  const { size, modules } = encodeQr(text, { ec });
  const dim = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && modules[y][x + run]) run++;
      path += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const px = formatNumber(dim * scale);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  );
}

/**
 * Render a QR code for terminals using half-block characters, two module rows
 * per text line. Only '█', '▀', '▄' and ' ' are used, so the code is drawn with
 * the terminal's default foreground/background colours.
 *
 * The quiet zone is always at least 4 modules, as ISO/IEC 18004 requires: for a
 * human-facing, camera-scanned symbol the quiet zone is not cosmetic. A smaller
 * margin (`margin` below 4) is raised to 4 rather than honoured silently — an
 * earlier version clamped to 2 and additionally padded an odd row count at the
 * bottom only, which produced an asymmetric 2/3 module quiet zone.
 *
 * Vertical padding is kept symmetric, so the top and bottom quiet zones are
 * always exactly equal.
 */
export function toTerminal(text: string, opts?: { ec?: EcLevel; margin?: number }): string[] {
  const ec = validateEc(opts?.ec ?? 'M');
  const requested = opts?.margin ?? 4;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError(`margin must be a non-negative integer, got ${String(requested)}`);
  }
  const margin = Math.max(4, requested);
  const { size, modules } = encodeQr(text, { ec });

  const width = size + margin * 2;

  // Half-block characters pack two module rows per text line, so vertical
  // padding must be an even number of modules to stay symmetric. Grow the
  // padded core (invisible for an all-light symbol) until it is even.
  let paddedHeight = size + margin * 2;
  if (paddedHeight % 2 !== 0) paddedHeight += 1;
  const padTop = Math.floor((paddedHeight - size) / 2);

  const rows = paddedHeight;
  const lines: string[] = [];
  for (let line = 0; line * 2 < rows; line++) {
    const yTop = line * 2 - padTop;
    const yBot = yTop + 1;
    let out = '';
    for (let col = 0; col < width; col++) {
      const x = col - margin;
      const top = yTop >= 0 && yTop < size && x >= 0 && x < size && modules[yTop][x];
      const bot = yBot >= 0 && yBot < size && x >= 0 && x < size && modules[yBot][x];
      out += top ? (bot ? '\u2588' : '\u2580') : bot ? '\u2584' : ' ';
    }
    lines.push(out);
  }
  return lines;
}

/** Formats a number for SVG attributes without float noise. */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}
