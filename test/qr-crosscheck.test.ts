/**
 * 二维码交叉验证：用独立构造器重建整符号，与编码器输出逐模块比对。
 *
 * 这是本套测试里最强的一项，思路是"两条腿走路"：
 *  1. 用 `encodeQr()` 编码得到矩阵
 *  2. 用**独立实现**的解码器 `qrdec.mjs` 把它解回码字，并独立判定块结构
 *  3. 用**独立实现**的构造器 `qrbuild.mjs` 从那些码字重新造一个符号
 *  4. 要求两者**逐模块完全相同**
 *
 * 为什么这比"自己解码自己"强得多：如果编码器在交织、掩码、格式信息或
 * 矩阵布局上偏离规范，"自己解自己"仍可能通过（两边犯同一个错）。
 * 而独立构造器是另一套代码，只有编码器真正符合 ISO/IEC 18004 才可能对上。
 *
 * 这两个独立实现由独立审计方编写、并已就其自身做过 0 失败的验证；
 * 基线输出保存在 `test/lib/qr-audit-baseline.txt`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeQr } from '../src/lib/qr.ts';

// @ts-expect-error 独立工具是纯 JS，刻意不引入类型声明与构建链
const decoder = await import('./lib/qrdec.mjs');
// @ts-expect-error 同上
const builder = await import('./lib/qrbuild.mjs');

interface DecodeReport {
  version: number;
  ec: string;
  mask: number;
  syndromeFailures: number;
  codewords: number[];
  structure: { numBlocks: number; ecLen: number; dataCodewords: number; numShortBlocks: number; shortDataLen: number };
  remainderAllZero: boolean;
  text: string;
}

const { decodeMatrix } = decoder as {
  decodeMatrix: (m: boolean[][], opts?: Record<string, unknown>) => DecodeReport;
};

const { buildSymbol, addEccAndInterleave, interleaveBlocks, rsGenerator, rsRemainder } = builder as {
  /** 返回的是 `{ modules, placedBits, size }`，不是裸矩阵。 */
  buildSymbol: (
    version: number,
    ec: string,
    interleaved: number[],
    mask: number,
  ) => { modules: boolean[][]; placedBits: number; size: number };
  addEccAndInterleave: (data: number[], numBlocks: number, ecLen: number) => number[];
  interleaveBlocks: (blocks: number[][], dataLens: number[], ecLen: number) => number[];
  rsGenerator: (degree: number) => number[];
  rsRemainder: (data: number[], gen: number[]) => number[];
};

const { deinterleave, dataCodewordsOf } = decoder as {
  deinterleave: (codewords: number[], numBlocks: number, ecLen: number) => unknown;
  dataCodewordsOf: (de: unknown) => number[];
};

/** 数出两个矩阵之间不同的模块位置。 */
function differingModules(a: boolean[][], b: boolean[][]): string[] {
  const diffs: string[] = [];
  for (let y = 0; y < a.length; y += 1) {
    for (let x = 0; x < a.length; x += 1) {
      if (a[y]![x] !== b[y]![x]) diffs.push(`(${x},${y})`);
    }
  }
  return diffs;
}

describe('二维码交叉验证（独立构造器重建）', () => {
  const payloads: { name: string; text: string; ec: 'L' | 'M' | 'Q' | 'H' }[] = [
    { name: '配对 URL @ M', text: 'http://192.168.1.100:8787/#t=' + 'A'.repeat(43), ec: 'M' },
    { name: '配对 URL @ L', text: 'http://192.168.1.100:8787/#t=' + 'A'.repeat(43), ec: 'L' },
    { name: '配对 URL @ Q', text: 'http://192.168.1.100:8787/#t=' + 'A'.repeat(43), ec: 'Q' },
    { name: '配对 URL @ H', text: 'http://192.168.1.100:8787/#t=' + 'A'.repeat(43), ec: 'H' },
    { name: '短文本', text: 'hi', ec: 'M' },
    { name: '中文', text: '手机与电脑互传', ec: 'M' },
    { name: 'emoji', text: '🎉 传文件 📱→💻', ec: 'Q' },
    { name: '300 字节', text: 'A'.repeat(300), ec: 'M' },
    { name: '1000 字节 @ L', text: 'B'.repeat(1000), ec: 'L' },
    { name: '2000 字节 @ L', text: 'C'.repeat(2000), ec: 'L' },
  ];

  for (const { name, text, ec } of payloads) {
    it(`${name}：独立重建的符号与编码器输出逐模块一致`, () => {
      const { modules } = encodeQr(text, { ec });

      // 先确认矩阵本身合法可解，并让解码器独立判定块结构。
      const report = decodeMatrix(modules, { report: true });
      assert.equal(report.text, text, '解码结果应与原文一致');
      assert.equal(report.syndromeFailures, 0, 'RS 伴随式必须全为零');
      assert.equal(report.ec, ec, `格式信息里读出的纠错等级应为 ${ec}`);
      assert.equal(report.remainderAllZero, true, '剩余位必须全为零');

      const { numBlocks, ecLen } = report.structure;

      // 反交织取回数据码字，再用独立构造器重新交织 + 纠错 + 布局 + 掩码。
      const dataCodewords = dataCodewordsOf(deinterleave(report.codewords, numBlocks, ecLen));
      const interleaved = addEccAndInterleave(dataCodewords, numBlocks, ecLen);
      const { modules: rebuilt } = buildSymbol(report.version, ec, interleaved, report.mask);

      // 第一层：重新交织出的码流必须与从矩阵读出的完全一致。
      assert.deepEqual(
        interleaved,
        report.codewords,
        '独立交织器产出的码流与矩阵中读出的一致（否则说明交织或纠错环节有偏差）',
      );

      // 第二层：整符号逐模块一致。
      assert.equal(rebuilt.length, modules.length, '矩阵尺寸应一致');
      const diffs = differingModules(modules, rebuilt);
      assert.deepEqual(
        diffs,
        [],
        `有 ${diffs.length} 个模块与独立重建的结果不一致（前 10 个：${diffs.slice(0, 10).join(' ')}）`,
      );
    });
  }

  it('interleaveBlocks 与 addEccAndInterleave 自洽（交叉验证的前置条件）', () => {
    // 确认独立构造器自身的两个入口是一回事，避免把工具自身的缺陷
    // 误判成编码器的问题。先用它自己的 RS 给数据块补上纠错码字，
    // 再分别用两个入口做交织。
    const data = [0x40, 0x26, 0x86, 0x90, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    const ecLen = 10;
    const ec = rsRemainder(data, rsGenerator(ecLen));
    const block = [...data, ...ec];

    const viaHelper = addEccAndInterleave(data, 1, ecLen);
    const viaBlocks = interleaveBlocks([block], [data.length], ecLen);

    assert.deepEqual(viaHelper, viaBlocks, '两个入口对单块输入应产出同一码流');
    assert.equal(viaHelper.length, data.length + ecLen, '码流长度应为数据+纠错');
  });

  it('内容不同时符号必须不同（防止编码器忽略输入）', () => {
    const a = encodeQr('内容甲', { ec: 'M' }).modules;
    const b = encodeQr('内容乙', { ec: 'M' }).modules;
    assert.equal(a.length, b.length);
    assert.ok(differingModules(a, b).length > 0, '不同内容不应产生完全相同的符号');
  });
});
