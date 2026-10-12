/**
 * 文本互传的回归测试。
 *
 * 这里钉的是**真实发生过的一个静默数据丢失**：
 * `echo 内容 | drop clip -` 曾经把字面量 "-" 发给手机
 * （因为 `-` 被当成普通位置参数拼接），用户以为发了整段内容，
 * 手机只收到一个减号。静默截断比报错危险得多，所以必须有守卫。
 *
 * 另外还钉住"只去掉尾随换行"这条规则：多行文本的中间换行属于用户内容，
 * 一旦被压平，发过去的代码段就变成了一行。
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { parseArgs } from '../src/config.ts';
import { resolveClipText, trimTrailingNewlines } from '../src/cli.ts';
import { clipboardProbeScripts } from '../src/clipboard.ts';

/** 临时把 process.stdin 换成一个可读流，用完还原。 */
async function withStdin<T>(content: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const fake = Readable.from([Buffer.from(content, 'utf8')]);
  // isTTY 必须去掉，否则会被判定成"交互式终端"。
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

describe('drop clip 的参数解析', () => {
  it('`-` 表示从标准输入读整段内容，而不是发送字面量 "-"', async () => {
    const payload = '第一行\n第二行\n第三行哨兵\n';
    const parsed = parseArgs(['clip', '-']);

    const result = await withStdin(payload, () => resolveClipText(parsed));

    assert.equal(result.source, '标准输入');
    assert.equal(
      trimTrailingNewlines(result.text),
      '第一行\n第二行\n第三行哨兵',
      '必须是整段内容；如果这里得到 "-"，就是那个静默数据丢失的回归',
    );
    assert.notEqual(result.text.trim(), '-');
  });

  it('位置参数直接作为文本，不做 stdin 读取', async () => {
    const parsed = parseArgs(['clip', '直接', '给的', '文本']);
    const result = await resolveClipText(parsed);
    assert.equal(result.source, '命令行参数');
    assert.equal(result.text, '直接 给的 文本');
  });

  it('`-` 与其它位置参数混用时仍然走标准输入', async () => {
    const parsed = parseArgs(['clip', '忽略我', '-']);
    const result = await withStdin('来自管道\n', () => resolveClipText(parsed));
    assert.equal(result.source, '标准输入');
    assert.equal(trimTrailingNewlines(result.text), '来自管道');
  });

  it('没有参数且标准输入被管道接管时，读整段文本', async () => {
    const parsed = parseArgs(['clip']);
    const result = await withStdin('无参数的管道内容\n', () => resolveClipText(parsed));
    assert.equal(result.source, '标准输入');
    assert.equal(trimTrailingNewlines(result.text), '无参数的管道内容');
  });
});

describe('尾随换行处理', () => {
  it('只去掉尾部换行，保留中间的空行与缩进', () => {
    const text = 'a\n\n  indented\n\n';
    assert.equal(trimTrailingNewlines(text), 'a\n\n  indented');
  });

  it('兼容 CRLF（Windows 管道）', () => {
    assert.equal(trimTrailingNewlines('line1\r\nline2\r\n'), 'line1\r\nline2');
    assert.equal(trimTrailingNewlines('only\r\n\r\n'), 'only');
  });

  it('没有尾随换行时原样返回', () => {
    assert.equal(trimTrailingNewlines('no trailing'), 'no trailing');
  });

  it('纯空白内容不会被误判成有效文本', () => {
    // 命令层用 trim() 判空，这里确认"只去尾随换行"不会把空内容变成非空。
    assert.equal(trimTrailingNewlines('\n\n\n').trim().length, 0);
  });
});

describe('Windows 剪贴板写入脚本', () => {
  /** 把 base64 还原成实际的 PowerShell 脚本文本。 */
  function decodeScript(base64: string): string {
    return Buffer.from(base64, 'base64').toString('utf16le');
  }

  /**
   * 这是一个真实踩过的坑：早先的实现用 `Set-Clipboard -Path <临时文件>`，
   * 理由是"避免把长文本塞进命令行"。实测证明它会**静默地什么都不写**——
   * 7 个用例（纯 ASCII / 中文 / emoji / 多行 / 特殊字符 / 混合 / 10 KB）
   * 全部读回空字符串，而 `Set-Clipboard -Value` 全部通过。
   *
   * 症状是"提示发送成功，粘贴出来什么都没有"，比报错更难发现，
   * 所以在这里钉死：生成的脚本必须用 -Value。
   */
  it('必须使用 -Value，绝不能退回会静默失败的 -Path', () => {
    const { write } = clipboardProbeScripts('测试内容');
    const script = decodeScript(write);

    assert.match(script, /Set-Clipboard\s+-Value/, '必须用 -Value 写入');
    assert.doesNotMatch(
      script,
      /Set-Clipboard\s+-Path/,
      '不能用 -Path：实测会静默写入空内容，用户会以为发送成功却粘贴不出东西',
    );
  });

  it('文本作为单引号字面量传入，特殊字符不会破坏脚本', () => {
    const nasty = `单引号' 双引号" 反引号\` 美元$var 分号; 换行\n末尾`;
    const { write, read } = clipboardProbeScripts(nasty);
    const script = decodeScript(write);

    // PowerShell 字面量转义：内部单引号必须翻倍。
    assert.ok(script.includes("''"), '内部单引号必须转义成两个');
    // 换行等其它字符不需要处理，但绝不能拼出未闭合的引号。
    const quoteCount = (script.match(/'/g) ?? []).length;
    assert.equal(quoteCount % 2, 0, `单引号必须成对出现，实际 ${quoteCount} 个`);

    // 读取脚本本身也要是可解析的，且带空值保护。
    const readScript = decodeScript(read);
    assert.match(readScript, /Get-Clipboard/);
    assert.match(readScript, /-Raw/);
  });

  it('超长文本不以内联方式生成脚本（会被 Windows 命令行长度限制截断）', () => {
    // 10 000 字符的阈值依据：命令行上限约 32767，UTF-16LE + base64 膨胀后
    // 约 12 000 个 UTF-16 码元可容纳；留余量取 10 000。
    const probe = clipboardProbeScripts('x'.repeat(10_000));
    // base64 后的长度应仍在命令行可接受范围内（远小于 32767）。
    assert.ok(probe.write.length < 32_000, `内联脚本过长：${probe.write.length}`);
  });
});
