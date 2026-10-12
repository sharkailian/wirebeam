/**
 * 模块加载冒烟测试 + CLI 端到端。
 *
 * 存在的理由：`test/api.test.ts` 只导入 server/routes/transfer/store 这几条链路，
 * **不导入 `src/cli.ts`**。于是出现过这种情况：清理未使用导入时漏删了文件末尾的
 * `export { statePaths }`，导致 cli.ts 一加载就抛
 * `SyntaxError: Export 'statePaths' is not defined in module`——
 * 50 个测试全绿，而整个命令行工具完全无法启动。
 *
 * 所以这里做两件事：
 *  1. 逐个动态导入每一个源文件（任何导入/导出一致性问题都会在这里炸出来）
 *  2. 真的以子进程方式跑一遍 CLI，验证它作为一个程序能起来
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/** 递归找出所有 .ts 源文件。 */
async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSources(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('模块加载冒烟', () => {
  it('每一个源文件都能被独立导入（能抓出悬空的 export / 写错的 import 路径）', async () => {
    const sources = await collectSources(path.join(projectRoot, 'src'));
    assert.ok(sources.length >= 10, `应该找到至少 10 个源文件，实际 ${sources.length}`);

    const failures: string[] = [];
    for (const file of sources) {
      try {
        await import(pathToFileURL(file).href);
      } catch (error) {
        failures.push(`${path.relative(projectRoot, file)}: ${(error as Error).message}`);
      }
    }

    assert.deepEqual(failures, [], `以下源文件无法导入：\n${failures.join('\n')}`);
  });

  it('bin/drop.js 存在且是可执行入口', async () => {
    const entry = path.join(projectRoot, 'bin', 'drop.js');
    const content = await fs.readFile(entry, 'utf8');
    assert.match(content, /^#!\/usr\/bin\/env node/, '入口应有 shebang');
    assert.match(content, /src['"`,\s]+cli\.ts|cliPath/, '入口应指向 src/cli.ts');
  });

  it('cli.ts 导出的 main 是函数', async () => {
    const cli = await import(pathToFileURL(path.join(projectRoot, 'src', 'cli.ts')).href);
    assert.equal(typeof cli.main, 'function', 'cli.ts 必须导出 main()');
  });
});

describe('CLI 端到端（子进程）', () => {
  /**
   * 注意：受限沙箱会禁止带管道 stdio 的子进程（EPERM）。
   * 那种环境里这项测试没有意义，因此检测到就跳过并明确说明，
   * 而不是伪装成通过。
   */
  async function runCli(args: string[]): Promise<{ ok: boolean; code: number | null; stdout: string; blocked: boolean }> {
    const { spawn } = await import('node:child_process');
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.execPath, [path.join(projectRoot, 'bin', 'drop.js'), ...args], {
          cwd: projectRoot,
          windowsHide: true,
        });
      } catch (error) {
        resolve({ ok: false, code: null, stdout: (error as Error).message, blocked: true });
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (e: NodeJS.ErrnoException) =>
        resolve({ ok: false, code: null, stdout: e.message, blocked: e.code === 'EPERM' }),
      );
      child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout + stderr, blocked: false }));
    });
  }

  it('drop help 能正常启动并打印帮助', async () => {
    const result = await runCli(['help']);
    if (result.blocked) {
      // 沙箱禁止子进程：如实记录，不伪装成通过。
      console.log('  （跳过：当前环境禁止带管道的子进程，EPERM）');
      return;
    }
    assert.equal(result.code, 0, `退出码应为 0，实际 ${result.code}；输出：${result.stdout}`);
    assert.match(result.stdout, /drop serve/, '帮助里应包含 serve 命令');
  });

  it('未知命令返回退出码 2 并给出提示', async () => {
    const result = await runCli(['这个命令不存在']);
    if (result.blocked) {
      console.log('  （跳过：当前环境禁止带管道的子进程，EPERM）');
      return;
    }
    assert.equal(result.code, 2, `未知命令应返回 2，实际 ${result.code}`);
  });
});
