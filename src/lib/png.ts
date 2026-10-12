/**
 * 最小 PNG 编码器（用于把二维码渲染成图片给手机浏览器看）。
 *
 * 只实现灰度、无隔行、位深 8、不滤波（filter type 0）这一条路径，
 * 够用且实现量极小。zlib 压缩用 Node 内置的 node:zlib。
 */

import zlib from 'node:zlib';

export interface PngOptions {
  /** 每个模块放大成多少像素。 */
  scale?: number;
  /** 静默区（模块数）。 */
  margin?: number;
  /** 前景色 [r,g,b]，默认纯黑。 */
  dark?: [number, number, number];
  /** 背景色，默认纯白。 */
  light?: [number, number, number];
}

/** 把布尔矩阵编码为 PNG 字节流。 */
export function encodePng(modules: boolean[][], options: PngOptions = {}): Buffer {
  const scale = Math.max(1, Math.floor(options.scale ?? 6));
  const margin = Math.max(0, Math.floor(options.margin ?? 4));
  const dark = options.dark ?? [0, 0, 0];
  const light = options.light ?? [255, 255, 255];

  const gridSize = modules.length;
  if (gridSize === 0) throw new Error('二维码矩阵为空');

  const size = (gridSize + margin * 2) * scale;
  // 每行：1 字节 filter type + size*3 字节 RGB
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(stride * size, 0);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0 (None)

    const moduleY = Math.floor(y / scale) - margin;
    for (let x = 0; x < size; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      const isDark =
        moduleY >= 0 &&
        moduleY < gridSize &&
        moduleX >= 0 &&
        moduleX < gridSize &&
        modules[moduleY]?.[moduleX] === true;

      const color = isDark ? dark : light;
      const offset = rowStart + 1 + x * 3;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
    }
  }

  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // 签名
    chunk('IHDR', ihdr(size, size)),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ];

  return Buffer.concat(chunks);
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // 位深
  data[9] = 2; // 颜色类型 2 = truecolor RGB
  data[10] = 0; // 压缩方法
  data[11] = 0; // 滤波方法
  data[12] = 0; // 隔行：无
  return data;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}
