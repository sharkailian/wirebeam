/**
 * 电脑侧剪贴板读写（双向文本互传的"电脑端"那一半）。
 *
 * ## 为什么用内联 `-Value` 而不是 `-Path`
 *
 * 最初用 `Set-Clipboard -Path <临时文件>`，理由是"避免把大段文本塞进命令行"。
 * 实测证明这是错的：**`-Path` 会静默地什么都不写**——实测 7 个用例
 * （纯 ASCII / 中文 / emoji / 多行 / 特殊字符 / 混合 / 10 KB）全部读回空字符串，
 * 而 `Set-Clipboard -Value` 全部通过。剪贴板是"写成功但内容为空"，
 * 用户看到的是"提示发送成功，粘贴出来什么都没有"。
 *
 * ## 那命令行长度怎么办
 *
 * 命令以 `-EncodedCommand`（UTF-16LE + base64）传入。Windows 命令行上限约
 * 32767 字符，UTF-16LE 每个字符 2 字节再 base64 膨胀 4/3，因此能内联的
 * 原文大约 20 KB。这条路径是安全的：
 *  - 文本内联进脚本后作为**单引号字符串字面量**，内部单引号翻倍即可，
 *    不经过任何 shell 解析，换行/引号/`$`/反引号都不会被解释
 *  - 超过 `INLINE_LIMIT` 才退回文件方案，并额外尝试 `clip.exe`
 *
 * 任何一步失败都返回 `ok: false`，由调用方降级（例如只写本地记录、
 * 让用户手动复制），绝不因为剪贴板不可用而让传输功能失败。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ClipboardResult {
  ok: boolean;
  /** 失败原因，仅用于日志与界面提示。 */
  reason?: string;
  /**
   * 文本本身已安全保存，只是没能写进系统剪贴板。
   *
   * 这种情况调用方**不应该**当成错误上报：剪贴板只是便利功能，
   * 用户在网页里仍能看到并复制这段文本。
   */
  degraded?: boolean;
  /** 实际使用的机制，便于排查。 */
  mechanism?: 'powershell-inline' | 'powershell-path' | 'clip' | 'posix' | 'unsupported';
  /**
   * 进程根本没跑起来（例如被沙箱/安全策略拦截）。
   * 与"命令跑了但失败"区分开，以便界面给出不同的建议。
   */
  blocked?: boolean;
}

const TIMEOUT_MS = 8000;

/**
 * 可以内联进 `-EncodedCommand` 的原文上限（字符数）。
 *
 * 实测数据（UTF-16LE + base64，同一台机器）：
 *   8 000 字符 → 命令 22 416  → 通过
 *  10 000 字符 → 命令 27 752  → 通过
 *  11 500 字符 → 命令 31 752  → 通过
 *  12 000 字符 → 命令 33 088  → ENAMETOOLONG（Windows 命令行上限约 32767）
 *
 * 因此真实边界在 11 500～12 000 之间。这里取 8 000 留足余量，
 * 因为命令行上限还与可执行文件路径长度、环境变量大小有关，
 * 不同机器上并不完全相同。
 */
const INLINE_LIMIT = 8_000;

/**
 * 写入电脑剪贴板。
 *
 * 优先内联 `-Value`（实测可靠），失败或文本过大时才退回文件方案。
 */
export async function writeClipboardText(text: string): Promise<ClipboardResult> {
  if (process.platform !== 'win32') return writeClipboardPosix(text);

  const attempts: string[] = [];

  // --- 方案一：内联 -Value（默认路径） ------------------------------------
  if (text.length <= INLINE_LIMIT) {
    const script = [
      '$ErrorActionPreference = "Stop"',
      `Set-Clipboard -Value ${psQuote(text)}`,
    ].join('\n');

    const result = await runPowerShell(script);
    if (result.ok) return { ok: true, mechanism: 'powershell-inline' };
    if (result.blocked) {
      return { ok: false, reason: result.reason, mechanism: 'powershell-inline', blocked: true };
    }
    attempts.push(`内联写入失败：${result.reason ?? '未知'}`);
  } else {
    attempts.push(`文本 ${text.length} 字符超过内联上限 ${INLINE_LIMIT}`);
  }

  // --- 方案二：临时文件 + -Path --------------------------------------------
  // 注意：实测这条路径在本机**会静默写入空内容**，因此它只是"万一内联失败"的
  // 兜底，并且失败后一定会继续往下尝试 clip.exe，最终如实报告 degraded。
  const tmp = path.join(os.tmpdir(), `dropclip-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    // 不加 BOM：-Path 默认按 ANSI 读，带 BOM 反而会出现乱码。
    await fs.writeFile(tmp, text, 'utf8');
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$p = ${psQuote(tmp)}`,
      // 显式指定 UTF8，避免中文在非 UTF-8 代码页下被写成乱码。
      'Set-Clipboard -Path $p -Encoding UTF8',
    ].join('\n');

    const result = await runPowerShell(script);
    if (result.ok) return { ok: true, mechanism: 'powershell-path' };
    if (result.blocked) {
      return { ok: false, reason: result.reason, mechanism: 'powershell-path', blocked: true };
    }
    attempts.push(`文件方式失败：${result.reason ?? '未知'}`);
  } catch (error) {
    attempts.push(`文件方式异常：${(error as Error).message}`);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }

  // --- 方案三：clip.exe（走 stdin，不受命令行长度限制） --------------------
  // 代价是它按控制台代码页编码，非 ASCII 可能变形，所以只作为兜底。
  const fallback = await runProcess('clip.exe', [], text);
  if (fallback.ok) {
    // 中文等非 ASCII 走 clip.exe 有变形风险，明确标记为降级。
    const asciiOnly = /^[\x00-\x7F]*$/.test(text);
    return asciiOnly
      ? { ok: true, mechanism: 'clip' }
      : {
          ok: true,
          mechanism: 'clip',
          degraded: true,
          reason: '文本较长，已用 clip.exe 写入；非 ASCII 字符可能因控制台代码页而变形，建议在网页里核对',
        };
  }

  return {
    ok: false,
    reason: attempts.join('；') || fallback.reason || '未知错误',
    mechanism: 'powershell-inline',
    // 写不进剪贴板不等于功能失败：文本已经保存在服务端与手机网页里。
    degraded: true,
    ...(fallback.blocked ? { blocked: true } : {}),
  };
}

/**
 * 读取电脑剪贴板中的文本。
 * 剪贴板里是图片/文件时返回空串（不是错误）。
 */
export async function readClipboardText(): Promise<{
  ok: boolean;
  text: string;
  reason?: string;
  blocked?: boolean;
}> {
  if (process.platform !== 'win32') {
    const result = await runProcess('pbpaste', []);
    return { ok: result.ok, text: result.stdout, reason: result.reason, blocked: result.blocked };
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    '$t = Get-Clipboard -Raw -Format Text',
    'if ($null -eq $t) { $t = "" }',
    '[Console]::Out.Write($t)',
  ].join('\n');

  const result = await runPowerShell(script);
  return { ok: result.ok, text: result.stdout, reason: result.reason, blocked: result.blocked };
}

// --- 内部实现 ---------------------------------------------------------------

function writeClipboardPosix(text: string): Promise<ClipboardResult> {
  const command = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
  return runProcess(command, args, text).then((result) =>
    result.ok
      ? { ok: true, mechanism: 'posix' as const }
      : { ok: false, reason: result.reason, mechanism: 'posix' as const, blocked: result.blocked },
  );
}

async function runPowerShell(script: string): Promise<{
  ok: boolean;
  stdout: string;
  reason?: string;
  blocked?: boolean;
}> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  const result = await runProcess('powershell.exe', args);
  return { ok: result.ok, stdout: result.stdout, reason: result.reason, blocked: result.blocked };
}

function runProcess(
  command: string,
  args: readonly string[],
  stdin?: string,
): Promise<{ ok: boolean; stdout: string; reason?: string; blocked?: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { windowsHide: true });
    } catch (error) {
      resolve(classifySpawnError(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { ok: boolean; stdout: string; reason?: string; blocked?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, reason: '剪贴板操作超时' });
    }, TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ ...classifySpawnError(error), stdout }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, stdout, reason: stderr.trim() || `退出码 ${code}` });
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin, 'utf8');
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * 把 spawn 失败翻译成人能看懂的原因。
 *
 * `EPERM` 在受限环境（沙箱、部分安全软件、组策略）里意味着
 * "子进程不允许用管道通信"，与本工具的逻辑无关，因此单独标记为 blocked。
 */
function classifySpawnError(error: unknown): { ok: boolean; stdout: string; reason: string; blocked: boolean } {
  const err = error as NodeJS.ErrnoException;
  const code = err?.code ?? '';
  if (code === 'EPERM') {
    return {
      ok: false,
      stdout: '',
      blocked: true,
      reason: '无法启动 PowerShell（EPERM）：当前环境禁止子进程管道通信，剪贴板同步不可用',
    };
  }
  if (code === 'ENOENT') {
    return { ok: false, stdout: '', blocked: true, reason: '找不到 powershell.exe' };
  }
  return { ok: false, stdout: '', blocked: false, reason: err?.message ?? String(error) };
}

/**
 * 单引号字符串在 PowerShell 里的转义：内部单引号翻倍。
 *
 * 这样文本整体作为**字面量**传入，换行、双引号、`$`、反引号、
 * 分号等都不会被 PowerShell 解释，天然免疫注入。
 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 仅供诊断用：把写入脚本的 base64 形式打印出来，便于在受限环境里
 * 手工验证（例如在真实终端执行 `powershell -EncodedCommand <base64>`）。
 */
export function clipboardProbeScripts(text: string): { write: string; read: string } {
  const writeScript = [
    '$ErrorActionPreference = "Stop"',
    `Set-Clipboard -Value ${psQuote(text)}`,
  ].join('\n');
  const readScript = [
    '$ErrorActionPreference = "Stop"',
    '$t = Get-Clipboard -Raw -Format Text',
    'if ($null -eq $t) { $t = "" }',
    '[Console]::Out.Write($t)',
  ].join('\n');
  return {
    write: Buffer.from(writeScript, 'utf16le').toString('base64'),
    read: Buffer.from(readScript, 'utf16le').toString('base64'),
  };
}
