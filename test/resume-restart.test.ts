/**
 * 跨进程重启的断点续传测试。
 *
 * 为什么必须单独测、而且必须用**两个真实进程**：
 *
 * 手机锁屏时，最坏情况不只是"连接断了"，而是电脑上的服务被关掉再打开
 * （用户重启服务、电脑休眠唤醒、进程崩溃重启）。这时"已收到哪些分片"
 * 只能靠磁盘上的状态恢复。同进程内重启 store 是测不出这个的——
 * 内存里的 Map 还在，恰好会掩盖真正的缺陷。
 *
 * 而且这个测试有历史意义：开发过程中确实出现过"分片计划存在 WeakMap 里"
 * 的写法，进程一重启计划就丢，续传会算出错误的分片数。所以这里要钉死：
 * **子进程 A 传一半就退出，子进程 B 接着传完，最终哈希必须一致。**
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildConfig, type Config } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

interface ServerHandle {
  port: number;
  pin: string;
  oneTimeToken: string;
  stop: () => Promise<void>;
  stdout: () => string;
}

/**
 * 在一个**独立进程**里起服务。
 *
 * 用子进程而不是同进程 import：要验证的正是"进程级状态全部丢失"之后的恢复能力。
 * 子进程通过 stdout 输出一行 JSON 把端口与配对信息回传。
 * 注意：某些受限沙箱禁止带管道的子进程（EPERM），调用方需要如实跳过。
 */
async function spawnServer(stateDir: string, recvDir: string): Promise<ServerHandle> {
  const script = `
    const { buildConfig } = await import('file:///${projectRoot.replace(/\\/g, '/')}/src/config.ts');
    const { startServer } = await import('file:///${projectRoot.replace(/\\/g, '/')}/src/server.ts');
    const base = buildConfig({ command: 'serve', positional: [], flags: new Map() });
    const server = await startServer({
      config: { ...base, host: '127.0.0.1', port: 0, loopbackOnly: true,
        recvDir: ${JSON.stringify(recvDir)}, stateDir: ${JSON.stringify(stateDir)},
        chunkSize: 64 * 1024, syncClipboard: false, pairTtlMs: 600000 },
      log: () => {},
    });
    process.stdout.write(JSON.stringify({ ready: true, port: server.port,
      pin: server.pin, token: server.oneTimeToken }) + '\\n');
  `;

  const child = (() => {
    try {
      return spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: projectRoot,
        windowsHide: true,
      });
    } catch (error) {
      // 受限环境可能直接禁止创建子进程：sspawn 是同步抛错，必须在这里兜住。
      throw Object.assign(error as Error, { blocked: (error as NodeJS.ErrnoException).code === 'EPERM' });
    }
  })();

  let buffer = '';
  let allOutput = '';
  const ready = new Promise<{ port: number; pin: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程启动超时。输出：${allOutput}`)), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      allOutput += text;
      buffer += text;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline));
        if (parsed.ready) {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        // 还没拿到完整的 JSON 行。
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      allOutput += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(Object.assign(error, { blocked: error.code === 'EPERM' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 正常情况已经 resolve 了；这里只兜住"没起起来就退出"。
      reject(new Error(`子进程提前退出，code=${code}。输出：${allOutput}`));
    });
  });

  const info = await ready;
  return {
    port: info.port,
    pin: info.pin,
    oneTimeToken: info.token,
    stdout: () => allOutput,
    stop: async () => {
      child.kill();
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        setTimeout(resolve, 5000).unref?.();
      });
    },
  };
}

/** 一个能跨进程重启存活的"手机客户端"。 */
class PhoneClient {
  readonly base: string;
  private cookie = '';

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  async pair(token: string, pin: string): Promise<void> {
    const response = await fetch(`${this.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, pin }),
    });
    assert.equal(response.status, 200, `配对失败：${await response.text()}`);
    this.cookie = (response.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  }

  /** 直接用已有 Cookie（模拟手机重连后复用会话）。 */
  useCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async call(apiPath: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.base}${apiPath}`, {
      ...options,
      headers: { Cookie: this.cookie, ...(options.headers ?? {}) },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }
}

describe('跨进程重启后的断点续传', () => {
  it('进程 A 传一半退出，进程 B 接着传完，哈希一致', async (t) => {
    const root = path.join(os.tmpdir(), `dropsend-restart-${crypto.randomBytes(4).toString('hex')}`);
    const stateDir = path.join(root, 'state');
    const recvDir = path.join(root, 'recv');
    await fs.mkdir(root, { recursive: true });

    const payload = crypto.randomBytes(300 * 1024);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const chunkSize = 64 * 1024;
    const chunkCount = Math.ceil(payload.length / chunkSize);

    let first: ServerHandle | undefined;
    let second: ServerHandle | undefined;

    try {
      // ---- 进程 A：配对，上传前 2 块，然后"消失" ----------------------------
      try {
        first = await spawnServer(stateDir, recvDir);
      } catch (error) {
        if ((error as { blocked?: boolean }).blocked) {
          t.skip('当前环境禁止带管道的子进程（EPERM），跨进程测试无法执行');
          return;
        }
        throw error;
      }

      const phoneA = new PhoneClient(first.port);
      await phoneA.pair(first.oneTimeToken, first.pin);

      const created = await phoneA.call('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'folder',
          folderName: '重启测试',
          files: [{ relPath: '重启测试/大文件.bin', size: payload.length, sha256: digest, chunkSize }],
        }),
      });
      assert.equal(created.status, 201, `建任务失败：${JSON.stringify(created.body)}`);
      const transferId = created.body.transferId as string;

      for (const index of [0, 1]) {
        const slice = payload.subarray(index * chunkSize, (index + 1) * chunkSize);
        const put = await phoneA.call(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(slice),
        });
        assert.equal(put.status, 200, `分片 ${index} 上传失败`);
      }

      const cookie = phoneA.getCookie();
      await first.stop();
      first = undefined;

      // ---- 进程 B：全新进程，内存状态全无 ---------------------------------
      second = await spawnServer(stateDir, recvDir);
      const phoneB = new PhoneClient(second.port);

      // 会话也必须跨重启存活，否则手机回来还得重新配对一次。
      phoneB.useCookie(cookie);
      const session = await phoneB.call('/api/session');
      assert.equal(session.status, 200, '会话应当跨服务重启保持有效');

      // 关键：新进程必须能准确报出"已经收到哪两块"。
      const resumed = await phoneB.call(`/api/transfers/${transferId}`);
      assert.equal(resumed.status, 200, `查询续传进度失败：${JSON.stringify(resumed.body)}`);
      assert.equal(resumed.body.transfer.status, 'active');
      assert.deepEqual(
        resumed.body.received[0].received,
        [0, 1],
        '重启后必须仍能报告已收到的分片（这正是曾经被 WeakMap 弄丢的信息）',
      );

      // 只补传剩下的块。
      const remaining: number[] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        if (resumed.body.received[0].received.includes(index)) continue;
        remaining.push(index);
        const slice = payload.subarray(index * chunkSize, Math.min(payload.length, (index + 1) * chunkSize));
        const put = await phoneB.call(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(slice),
        });
        assert.equal(put.status, 200, `补传分片 ${index} 失败：${JSON.stringify(put.body)}`);
      }
      assert.equal(remaining.length, chunkCount - 2);

      const done = await phoneB.call(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
      assert.equal(done.status, 200, `完成失败：${JSON.stringify(done.body)}`);

      // ---- 内容必须与原文件逐字节一致 -------------------------------------
      const landed = await fs.readFile(path.join(recvDir, '重启测试', '大文件.bin'));
      assert.equal(crypto.createHash('sha256').update(landed).digest('hex'), digest);
    } finally {
      await first?.stop();
      await second?.stop();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('重启后再次重新配对也能正常工作（会话丢失的兜底路径）', async (t) => {
    const root = path.join(os.tmpdir(), `dropsend-repair-${crypto.randomBytes(4).toString('hex')}`);
    const stateDir = path.join(root, 'state');
    const recvDir = path.join(root, 'recv');
    await fs.mkdir(root, { recursive: true });

    let first: ServerHandle | undefined;
    let second: ServerHandle | undefined;

    try {
      try {
        first = await spawnServer(stateDir, recvDir);
      } catch (error) {
        if ((error as { blocked?: boolean }).blocked) {
          t.skip('当前环境禁止带管道的子进程（EPERM），跨进程测试无法执行');
          return;
        }
        throw error;
      }

      await first.stop();
      first = undefined;

      // 新进程会开新的配对窗口；PIN 与令牌都变了，手机重新扫一次即可。
      second = await spawnServer(stateDir, recvDir);
      const phone = new PhoneClient(second.port);
      await phone.pair(second.oneTimeToken, second.pin);

      const status = await phone.call('/api/system/status');
      assert.equal(status.status, 200);
      assert.ok(typeof status.body.recvDir === 'string');
    } finally {
      await first?.stop();
      await second?.stop();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
