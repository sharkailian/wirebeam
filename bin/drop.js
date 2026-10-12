#!/usr/bin/env node
/**
 * dropsend 的可执行入口。
 *
 * 这个文件故意保持极薄：只负责把参数交给 CLI，并把返回值转成退出码。
 * 真正的逻辑在 src/ 下，便于测试与复用。
 *
 * 注意：Node 22.6+ 才能直接运行 .ts（原生类型擦除），低版本会给出明确提示。
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(major) && major < 22) {
  process.stderr.write(
    `dropsend 需要 Node 22.6 或更高版本（当前 ${process.versions.node}）。\n` +
      '请升级 Node 后重试。\n',
  );
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');

let cliModule;
try {
  cliModule = await import(pathToFileURL(cliPath).href);
} catch (error) {
  // 最常见的失败原因不是代码问题，而是"启动方式不对"。
  // 与其抛一个 MODULE_NOT_FOUND 栈，不如直接给出能照着做的命令。
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) {
    const projectDir = path.resolve(here, '..');
    process.stderr.write(
      '\n找不到 dropsend 的源码文件。\n\n' +
        `  期望位置：${cliPath}\n\n` +
        '这通常是因为把 bin/drop.js 复制到了别处，或者项目目录被移动过。\n' +
        '请在完整解压的项目目录里运行，例如：\n\n' +
        `  cd /d "${projectDir}"\n` +
        '  node bin\\drop.js selfcheck\n\n' +
        '或者用项目自带的启动器（可在任意目录运行）：\n\n' +
        `  "${path.join(projectDir, 'drop.cmd')}" selfcheck\n`,
    );
    process.exit(1);
  }
  throw error;
}

const { main } = cliModule;

try {
  const code = await main(process.argv.slice(2));
  process.exit(code ?? 0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n出错了：${message}\n`);
  if (process.env.DROP_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
}
