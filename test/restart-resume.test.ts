/**
 * 断点续传的"彻底重启"测试（进程内版）。
 *
 * 与 `resume-restart.test.ts` 的关系：
 *  - 那个用**两个真实进程**验证，最贴近现实，但受限环境禁止子进程时会跳过；
 *  - 这个在**同一进程内重建整条服务**，同样把 StateStore / TransferEngine /
 *    Pairing / EventBus 全部丢弃重新创建，只用磁盘上的状态恢复。
 *    它覆盖不了"OS 进程边界"（例如全局变量没清干净），但能在任何环境跑，
 *    因此是默认会执行的回归防线。
 *
 * 这个场景对应目标里的"锁屏 30 秒后续传"：手机锁屏最坏会导致连接断开、
 * 服务被重启，此时"已收到哪些分片"只能来自磁盘。历史上这里真的出过缺陷
 * （分片计划放在 WeakMap 里，进程一重启就丢），所以两条测试都要有。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { buildConfig, type Config } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';

const CHUNK_SIZE = 64 * 1024;

interface Booted {
  server: RunningServer;
  cookie: string;
}

/**
 * 完整启动一套服务并完成配对。
 * 每次调用都会新建 StateStore / TransferEngine / Pairing，等价于"重启后重新开始"。
 */
async function boot(root: string, label: string): Promise<Booted> {
  const base = buildConfig({ command: 'serve', positional: [], flags: new Map() });
  const config: Config = {
    ...base,
    host: '127.0.0.1',
    port: 0,
    loopbackOnly: true,
    recvDir: path.join(root, 'recv'),
    stateDir: path.join(root, 'state'),
    chunkSize: CHUNK_SIZE,
    syncClipboard: false,
    pairTtlMs: 600_000,
  };

  const server = await startServer({ config, log: () => {} });

  const paired = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
  });
  assert.equal(paired.status, 200, `[${label}] 配对失败`);

  return { server, cookie: (paired.headers.getSetCookie()[0] ?? '').split(';')[0]! };
}

function phoneCall(booted: Booted, apiPath: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${booted.server.port}${apiPath}`, {
    ...options,
    headers: { Cookie: booted.cookie, ...(options.headers ?? {}) },
  });
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  assert.ok(response.ok, `HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

describe('彻底重启后的断点续传', () => {
  const created: string[] = [];

  after(async () => {
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('服务重启后：仍能报出已收分片、会话仍有效、补传后哈希一致', async () => {
    const root = path.join(os.tmpdir(), `dropsend-boot-${crypto.randomBytes(4).toString('hex')}`);
    created.push(root);
    await fs.mkdir(root, { recursive: true });

    const payload = crypto.randomBytes(300 * 1024);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const chunkCount = Math.ceil(payload.length / CHUNK_SIZE);

    // ---- 第一次启动：传一半 ------------------------------------------------
    const first = await boot(root, '第一次');
    const manifest = await json<{ transferId: string; files: { chunkCount: number }[] }>(
      await phoneCall(first, '/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'folder',
          folderName: '深处',
          files: [{ relPath: '深处/嵌套/中文文件名.bin', size: payload.length, sha256: digest, chunkSize: CHUNK_SIZE }],
        }),
      }),
    );
    assert.equal(manifest.files[0]!.chunkCount, chunkCount);

    for (const index of [0, 1]) {
      const slice = payload.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      const response = await phoneCall(first, `/api/transfers/${manifest.transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(slice),
      });
      assert.equal(response.status, 200);
    }

    // ---- 关停：所有内存状态就此丢失 ---------------------------------------
    await first.server.stop();

    // ---- 第二次启动：同一份磁盘状态，全新对象 -----------------------------
    const second = await boot(root, '第二次');

    // 会话跨重启存活：手机不用重新扫一次码。
    const session = await phoneCall(second, '/api/session');
    assert.equal(session.status, 200, '会话应当跨重启保持有效');

    const resumed = await json<{
      transfer: { status: string; parts?: unknown };
      received: { index: number; received: number[] }[];
    }>(await phoneCall(second, `/api/transfers/${manifest.transferId}`));

    assert.equal(resumed.transfer.status, 'active', '未完成任务重启后应仍可续传');
    assert.deepEqual(
      resumed.received[0]!.received,
      [0, 1],
      '重启后必须仍能报告已收到的分片——这条正是曾经被 WeakMap 弄丢的信息',
    );

    // 只补传缺的块，且刻意乱序，确认顺序无关。
    const missing: number[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      if (!resumed.received[0]!.received.includes(index)) missing.push(index);
    }
    assert.equal(missing.length, chunkCount - 2);

    for (const index of [...missing].reverse()) {
      const slice = payload.subarray(index * CHUNK_SIZE, Math.min(payload.length, (index + 1) * CHUNK_SIZE));
      const response = await phoneCall(second, `/api/transfers/${manifest.transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(slice),
      });
      assert.equal(response.status, 200, `补传分片 ${index} 失败`);
    }

    const done = await phoneCall(second, `/api/transfers/${manifest.transferId}/complete`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(done.status, 200, `完成失败：${await done.text()}`);

    // ---- 逐字节校验 -------------------------------------------------------
    const landed = await fs.readFile(path.join(root, 'recv', '深处', '嵌套', '中文文件名.bin'));
    assert.equal(
      crypto.createHash('sha256').update(landed).digest('hex'),
      digest,
      '跨重启续传后的文件必须与原文件逐字节一致',
    );

    await second.server.stop();
  });

  it('重启后未完成任务的临时分片不会被当作孤儿清掉', async () => {
    const root = path.join(os.tmpdir(), `dropsend-orphan-${crypto.randomBytes(4).toString('hex')}`);
    created.push(root);
    await fs.mkdir(root, { recursive: true });

    const payload = crypto.randomBytes(CHUNK_SIZE * 2);

    const first = await boot(root, '孤儿第一次');
    const manifest = await json<{ transferId: string }>(
      await phoneCall(first, '/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'file',
          files: [{ relPath: '孤儿检查.bin', size: payload.length, chunkSize: CHUNK_SIZE }],
        }),
      }),
    );

    await phoneCall(first, `/api/transfers/${manifest.transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload.subarray(0, CHUNK_SIZE)),
    });

    const partFile = path.join(root, 'state', 'chunks', manifest.transferId, '0.part');
    const before = await fs.stat(partFile);
    assert.ok(before.size > 0, '分片文件应已写入磁盘');

    await first.server.stop();

    // 启动时会 sweepOrphanParts()：只应清理"没有对应任务记录"的目录。
    const second = await boot(root, '孤儿第二次');

    const after = await fs.stat(partFile).catch(() => undefined);
    assert.ok(after, '未完成任务的分片文件不能被当成孤儿清掉，否则续传能力就丢了');
    assert.equal(after!.size, before.size, '分片内容不应被改动');

    const resumed = await json<{ received: { received: number[] }[] }>(
      await phoneCall(second, `/api/transfers/${manifest.transferId}`),
    );
    assert.deepEqual(resumed.received[0]!.received, [0]);

    await second.server.stop();
  });
});
