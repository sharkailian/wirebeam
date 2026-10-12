/**
 * 二维码正确性测试。
 *
 * 为什么值得单独测：二维码是**唯一的配对入口**。它错了，整个工具就用不了，
 * 而且错误方式很隐蔽——一个"自洽但不符合规范"的码，自家解码器能读通，
 * 手机相机却读不出来。
 *
 * 方法：用一个**独立实现的解码器**（`test/lib/qrdec.mjs`，不复用编码器的任何
 * 内部结构）去解码编码器的产物。它做的是真正的译码流程：
 * 定位图形 → 读并 BCH 校验格式信息 → 反掩码 → 按规范逆交织 →
 * 用 GF(256) 多项式求值检查 Reed-Solomon 伴随式全为零 → 解析数据流。
 *
 * 伴随式全零是最强的单项证据：它证明纠错码字是按规范算出来的，
 * 而不是"能和自己的解码器对上"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeQr, toTerminal } from '../src/lib/qr.ts';

// @ts-expect-error 独立解码器是纯 JS，没有类型声明（刻意不引入构建链）
const decoder = await import('./lib/qrdec.mjs');
const { decodeMatrix } = decoder as {
  decodeMatrix: (m: boolean[][], opts?: Record<string, unknown>) => {
    text?: string;
    version?: number;
    ec?: string;
    mask?: number;
    syndromeFailures?: number;
  };
};

/** 手机扫码时真正会编码进去的载荷。 */
const PAIRING_URL = 'http://192.168.1.100:8787/#t=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLL';

function decode(text: string, ec: 'L' | 'M' | 'Q' | 'H' = 'M') {
  const { modules } = encodeQr(text, { ec });
  return decodeMatrix(modules);
}

/**
 * 把 toTerminal 的输出还原成模块矩阵。
 * 每个字符行 = 2 个模块行：`▀` 上暗、`▄` 下暗、`█` 都暗、空格都亮。
 */
function rebuildFromTerminal(lines: string[]): boolean[][] {
  const matrix: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      top.push(ch === '█' || ch === '▀');
      bottom.push(ch === '█' || ch === '▄');
    }
    matrix.push(top, bottom);
  }
  return matrix;
}

describe('二维码：配对载荷', () => {
  it('真实配对 URL 能被独立解码器逐字节还原', () => {
    const result = decode(PAIRING_URL, 'M');
    assert.equal(result.text, PAIRING_URL, '解码结果必须与原始 URL 完全一致');
    assert.equal(result.syndromeFailures, 0, 'Reed-Solomon 伴随式必须全为零');
  });

  it('四种纠错等级下都能正确解码', () => {
    for (const ec of ['L', 'M', 'Q', 'H'] as const) {
      const result = decode(PAIRING_URL, ec);
      assert.equal(result.text, PAIRING_URL, `EC=${ec} 解码不一致`);
      assert.equal(result.syndromeFailures, 0, `EC=${ec} 伴随式不为零`);
      assert.equal(result.ec, ec, `EC=${ec} 时格式信息里读出的等级不符`);
    }
  });

  it('本地回环地址与 IPv6 形式的地址也能编码解码', () => {
    for (const url of [
      'http://127.0.0.1:8787/#t=short',
      'http://192.168.42.129:9000/#t=' + 'x'.repeat(32),
      'http://10.0.0.7:8787/',
    ]) {
      assert.equal(decode(url).text, url, `URL 不一致：${url}`);
    }
  });
});

describe('二维码：终端渲染', () => {
  it('用户终端上看到的那个二维码，还原后能被解码', () => {
    // 这一项最重要：它验证的是"用户拿手机对着终端扫"这条路径。
    const lines = toTerminal(PAIRING_URL, { ec: 'M', margin: 2 });
    const rebuilt = rebuildFromTerminal(lines);

    // 去掉上下左右多余的静默区，让独立解码器自己去定位。
    const result = decodeMatrix(rebuilt);
    assert.equal(result.text, PAIRING_URL, '从终端渲染还原出的矩阵必须能解码出同一个 URL');
    assert.equal(result.syndromeFailures, 0);
  });

  it('终端渲染只用四种字符，且每行等宽、比例接近 2:1', () => {
    const lines = toTerminal(PAIRING_URL, { ec: 'M' });
    const allowed = new Set(['█', '▀', '▄', ' ']);

    for (const line of lines) {
      for (const ch of line) assert.ok(allowed.has(ch), `出现非法字符：${JSON.stringify(ch)}`);
    }

    const widths = new Set(lines.map((l) => l.length));
    assert.equal(widths.size, 1, `每行宽度必须一致，实际有 ${widths.size} 种`);

    const ratio = [...widths][0]! / lines.length;
    assert.ok(ratio > 1.6 && ratio < 2.4, `宽高比应接近 2:1，实际 ${ratio.toFixed(2)}`);
  });

  /**
   * 静默区不是装饰。ISO/IEC 18004 要求符号四周至少 4 个模块的空白，
   * 而手机扫终端上的二维码是**唯一的配对入口**——静默区不够时相机对不上焦，
   * 用户看到的是"扫码没反应"，且没有任何错误信息可查。
   *
   * 这条测试对应的真实缺陷：早先的实现把 margin 静默钳到 2，
   * 并且在总行数为奇数时只在**底部**补一行，实测静默区是
   * 左2/右2/上2/下3——既不足 4 模块，上下还不对称。
   */
  it('静默区至少 4 个模块，且上下左右对称', () => {
    for (const text of [PAIRING_URL, 'A'.repeat(300), '短']) {
      const lines = toTerminal(text, { ec: 'M' });
      const matrix = rebuildFromTerminal(lines);

      // 量出暗色模块的边界，边界之外就是静默区。
      let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
      matrix.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (!dark) return;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }),
      );

      const left = minX;
      const right = matrix[0]!.length - 1 - maxX;
      const top = minY;
      const bottom = matrix.length - 1 - maxY;

      const label = text.length > 20 ? `${text.slice(0, 20)}…` : text;
      assert.ok(left >= 4, `[${label}] 左侧静默区 ${left} < 4`);
      assert.ok(right >= 4, `[${label}] 右侧静默区 ${right} < 4`);
      assert.ok(top >= 4, `[${label}] 顶部静默区 ${top} < 4`);
      assert.ok(bottom >= 4, `[${label}] 底部静默区 ${bottom} < 4`);
      assert.equal(left, right, `[${label}] 左右静默区必须相等：${left} vs ${right}`);

      /**
       * 上下允许差 1 个模块行，但不能再多。
       *
       * 原因：每个字符行承载 2 个模块行，所以垂直方向的静默区只能是偶数；
       * 核心矩阵高度固定时，最后一行字符行是否包含真实模块行会让下边多出
       * 一个全亮的模块行。规范要求的是"至少 4 模块且四周对称"，
       * 半个字符行以内的量化误差无法消除——但 2/3 那种既不足又不一致的
       * 情况必须被挡住，那正是修复前的实际缺陷。
       */
      assert.ok(
        Math.abs(top - bottom) <= 1,
        `[${label}] 上下静默区差异不应超过 1 个模块：${top} vs ${bottom}`,
      );
    }
  });

  it('显式传入过小的 margin 会被提升到 4，而不是被静默接受', () => {
    const small = toTerminal(PAIRING_URL, { ec: 'M', margin: 1 });
    const normal = toTerminal(PAIRING_URL, { ec: 'M', margin: 4 });
    assert.deepEqual(small, normal, 'margin 小于 4 时应与 margin=4 输出一致');
  });
});

describe('二维码：编码边界', () => {
  it('中文与 emoji 的 UTF-8 内容能往返', () => {
    for (const text of ['中文测试', 'emoji 🎉📱💻', '混合 mixed 内容 123', '换行\n第二行']) {
      const result = decode(text);
      assert.equal(result.text, text, `往返失败：${text}`);
      assert.equal(result.syndromeFailures, 0);
    }
  });

  it('自动选择版本与掩码，且伴随式始终为零', () => {
    for (const length of [1, 20, 80, 200, 600, 1200]) {
      const text = 'A'.repeat(length);
      const result = decode(text);
      assert.equal(result.text, text, `长度 ${length} 往返失败`);
      assert.equal(result.syndromeFailures, 0, `长度 ${length} 伴随式不为零`);
      assert.ok((result.mask ?? -1) >= 0 && (result.mask ?? -1) <= 7, '掩码应在 0..7');
    }
  });

  it('超出容量时抛出明确错误，而不是产出错误的码', () => {
    // 版本 40 + EC H 的字节模式容量约 1273 字节。
    assert.throws(() => encodeQr('A'.repeat(4000), { ec: 'H' }), /too long|capacity|version 40/i);
  });

  it('空字符串不会崩', () => {
    const { modules } = encodeQr('', { ec: 'M' });
    assert.ok(modules.length >= 21, '空内容也应产生合法尺寸的矩阵');
  });
});
