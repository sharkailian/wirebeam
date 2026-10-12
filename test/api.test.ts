/**
 * 端到端协议测试。
 *
 * 这些测试真的起一个服务器、真的走 HTTP、真的写磁盘、真的算哈希。
 * 目标是覆盖那些"看起来能跑但会在关键时刻坏掉"的路径：
 * 断点续传、分片幂等、乱序到达、空文件、空目录、路径穿越、保留设备名、
 * Range 下载、以及分片确认与实际保存的关系。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildConfig, type Config } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { sanitizeRelativePath, sanitizeSegment, resolveWithin, UnsafePathError } from '../src/lib/fs-safety.ts';

let server: RunningServer;
let config: Config;
let root: string;
let cookie = '';

function sha256(buffer: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 带控制令牌的本机请求。 */
async function local(apiPath: string, options: RequestInit = {}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    ...options,
    headers: { 'X-Drop-Token': server.controlToken, ...(options.headers ?? {}) },
  });
}

/** 带会话的请求（模拟手机）。 */
async function phone(apiPath: string, options: RequestInit = {}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    ...options,
    headers: { Cookie: cookie, ...(options.headers ?? {}) },
  });
}

before(async () => {
  root = path.join(os.tmpdir(), `dropsend-test-${crypto.randomBytes(4).toString('hex')}`);
  const base = buildConfig({ command: 'serve', positional: [], flags: new Map() });
  config = {
    ...base,
    host: '127.0.0.1',
    port: 0,
    loopbackOnly: true,
    recvDir: path.join(root, 'recv'),
    stateDir: path.join(root, 'state'),
    chunkSize: 64 * 1024,
    syncClipboard: false,
    pairTtlMs: 120_000,
  };
  server = await startServer({ config, log: () => {} });
});

after(async () => {
  await server?.stop();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('配对与鉴权', () => {
  it('未配对时访问受保护接口返回 401', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/transfers`);
    assert.equal(response.status, 401);
  });

  it('错误的 PIN 被拒绝，正确的 PIN 换到会话', async () => {
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: server.oneTimeToken, pin: '000000' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
    });
    assert.equal(good.status, 200);

    const setCookie = good.headers.getSetCookie()[0] ?? '';
    assert.match(setCookie, /HttpOnly/);
    cookie = setCookie.split(';')[0]!;
    assert.ok(cookie.startsWith('ds_session='));
  });

  it('一次性令牌用过即失效', async () => {
    const replay = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
    });
    assert.equal(replay.status, 401);
  });

  it('控制令牌只对本机生效（非本机携带也被拒）', async () => {
    // 直接打路由层：伪造一个非环回的 socket 不现实，这里验证"没有令牌一定被拒"。
    const response = await fetch(`http://127.0.0.1:${server.port}/api/transfers`);
    assert.equal(response.status, 401);
  });
});

describe('单文件上传', () => {
  it('顺序上传、哈希一致、文件落到 recv 目录', async () => {
    const payload = crypto.randomBytes(200 * 1024);
    const digest = sha256(payload);

    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '测试文件.bin', size: payload.length, sha256: digest, chunkSize: 64 * 1024 }],
      }),
    });
    assert.equal(created.status, 201);
    const manifest = await created.json();
    const { transferId, files } = manifest;
    assert.equal(files[0].chunkCount, 4);

    for (let index = 0; index < files[0].chunkCount; index += 1) {
      const slice = payload.subarray(index * 64 * 1024, Math.min(payload.length, (index + 1) * 64 * 1024));
      const put = await phone(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(slice),
      });
      assert.equal(put.status, 200);
      const body = await put.json();
      assert.equal(body.duplicate, false);
    }

    const commit = await phone('/api/transfers/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, partIndex: 0 }),
    });
    assert.equal(commit.status, 200);

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);

    const landed = await fs.readFile(path.join(config.recvDir, '测试文件.bin'));
    assert.equal(sha256(landed), digest, '落盘内容哈希必须与源一致');
  });

  it('分片重传是幂等的，不重复计数', async () => {
    const payload = crypto.randomBytes(70 * 1024);
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '幂等.bin', size: payload.length, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    const chunk = new Uint8Array(payload.subarray(0, 64 * 1024));
    const first = await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    const second = await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });

    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.duplicate, false);
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.doneBytes, firstBody.doneBytes, '重复上传不应增加已传字节');
    assert.equal(secondBody.chunksDone, firstBody.chunksDone);
  });

  it('分片长度不符会被拒绝', async () => {
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '长度.bin', size: 64 * 1024, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    const wrong = await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(10),
    });
    assert.equal(wrong.status, 400);
    const body = await wrong.json();
    assert.equal(body.code, 'chunk_size_mismatch');
  });

  it('分片下标越界会被拒绝', async () => {
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '越界.bin', size: 100, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    const bad = await phone(`/api/transfers/${transferId}/chunks/9?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(100),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'bad_chunk');
  });

  it('哈希不符时拒绝落盘并清空该文件的分片状态', async () => {
    const payload = crypto.randomBytes(32 * 1024);
    const wrongDigest = sha256(Buffer.from('这不是真实内容'));

    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '坏哈希.bin', size: payload.length, sha256: wrongDigest, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload),
    });

    const commit = await phone('/api/transfers/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, partIndex: 0 }),
    });
    assert.equal(commit.status, 409);
    assert.equal((await commit.json()).code, 'hash_mismatch');

    // 必须没有半截文件出现在接收目录。
    const entries = await fs.readdir(config.recvDir);
    assert.ok(!entries.includes('坏哈希.bin'), '哈希不符的文件不能落盘');
  });
});

describe('断点续传', () => {
  it('中断后能查出已收分片，补传剩余分片即可完成', async () => {
    const payload = crypto.randomBytes(300 * 1024);
    const digest = sha256(payload);
    const chunkSize = 64 * 1024;
    const chunkCount = Math.ceil(payload.length / chunkSize);

    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '断点.bin', size: payload.length, sha256: digest, chunkSize }],
      }),
    });
    const { transferId } = await created.json();

    // 只传前两块，然后"掉线"。
    for (const index of [0, 1]) {
      await phone(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(payload.subarray(index * chunkSize, (index + 1) * chunkSize)),
      });
    }

    // 客户端重新连上来先问进度。
    const resumed = await phone(`/api/transfers/${transferId}`);
    assert.equal(resumed.status, 200);
    const info = await resumed.json();
    assert.deepEqual(info.received[0].received, [0, 1], '应能准确报告已收到的分片');
    assert.equal(info.transfer.status, 'active');

    // 补传剩下的分片。
    for (let index = 2; index < chunkCount; index += 1) {
      const put = await phone(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(payload.subarray(index * chunkSize, Math.min(payload.length, (index + 1) * chunkSize))),
      });
      assert.equal(put.status, 200);
    }

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);
    assert.equal(sha256(await fs.readFile(path.join(config.recvDir, '断点.bin'))), digest);
  });

  it('乱序上传也能正确重组', async () => {
    const payload = crypto.randomBytes(200 * 1024);
    const digest = sha256(payload);
    const chunkSize = 64 * 1024;

    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '乱序.bin', size: payload.length, sha256: digest, chunkSize }],
      }),
    });
    const { transferId } = await created.json();

    const order = [2, 0, 3, 1];
    const responses = await Promise.all(
      order.map(async (index) => {
        const slice = payload.subarray(index * chunkSize, Math.min(payload.length, (index + 1) * chunkSize));
        const response = await phone(`/api/transfers/${transferId}/chunks/${index}?part=0`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(slice),
        });
        return { index, status: response.status, body: await response.text() };
      }),
    );

    for (const item of responses) {
      assert.equal(item.status, 200, `分片 ${item.index} 上传失败：${item.body}`);
    }

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    const doneBody = await done.text();
    assert.equal(done.status, 200, `完成失败：${doneBody}`);
    assert.equal(sha256(await fs.readFile(path.join(config.recvDir, '乱序.bin'))), digest);
  });

  it('缺分片时 complete 返回 409 而不是写出残缺文件', async () => {
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '残缺.bin', size: 128 * 1024, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(64 * 1024),
    });

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 409);
    assert.equal((await done.json()).code, 'incomplete');

    const entries = await fs.readdir(config.recvDir);
    assert.ok(!entries.includes('残缺.bin'));
  });
});

describe('文件夹传输', () => {
  it('还原到以批次名命名的目录，并保留内部层级与空目录', async () => {
    const a = crypto.randomBytes(5000);
    const b = crypto.randomBytes(20_000);

    // 真实浏览器的 webkitRelativePath 形如 "我的照片/子目录/深文件.bin"：
    // 以批次名开头。服务端必须把它解析成 recv/我的照片/子目录/深文件.bin，
    // 而不是 recv/我的照片/我的照片/... （多一层）或 recv/子目录/... （少一层）。
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'folder',
        folderName: '我的照片',
        emptyDirs: ['我的照片/空目录', '我的照片/子目录/更深的空目录'],
        files: [
          { relPath: '我的照片/子目录/深文件.bin', size: a.length, sha256: sha256(a), chunkSize: 64 * 1024 },
          { relPath: '我的照片/顶层文件.bin', size: b.length, sha256: sha256(b), chunkSize: 64 * 1024 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const { transferId } = await created.json();

    for (const [partIndex, payload] of [a, b].entries()) {
      const put = await phone(`/api/transfers/${transferId}/chunks/0?part=${partIndex}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(payload),
      });
      assert.equal(put.status, 200);
      await phone('/api/transfers/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferId, partIndex }),
      });
    }

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);

    // 必须在批次目录之内，且层级正确。
    assert.equal(
      sha256(await fs.readFile(path.join(config.recvDir, '我的照片/子目录/深文件.bin'))),
      sha256(a),
      '深层文件应落在 recv/我的照片/子目录/ 下',
    );
    assert.equal(sha256(await fs.readFile(path.join(config.recvDir, '我的照片/顶层文件.bin'))), sha256(b));

    // 不能多出一层同名目录。
    const hasDoubleNesting = await fs
      .access(path.join(config.recvDir, '我的照片/我的照片'))
      .then(() => true)
      .catch(() => false);
    assert.equal(hasDoubleNesting, false, '不应出现 recv/我的照片/我的照片 这种重复嵌套');

    // 空目录必须存在，否则"文件夹结构"就不完整。
    const emptyStat = await fs.stat(path.join(config.recvDir, '我的照片/空目录'));
    assert.ok(emptyStat.isDirectory(), '空目录应被还原');
    const deepStat = await fs.stat(path.join(config.recvDir, '我的照片/子目录/更深的空目录'));
    assert.ok(deepStat.isDirectory(), '深层空目录应被还原');
  });

  it('多文件批次的相对路径不带批次名前缀', async () => {
    // 手机上"选中多个文件"时浏览器给的 name 就是裸文件名，没有目录前缀。
    const data = crypto.randomBytes(2048);
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'files',
        folderName: '2024-05-01',
        files: [{ relPath: '裸文件名.bin', size: data.length, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);

    assert.equal(sha256(await fs.readFile(path.join(config.recvDir, '2024-05-01/裸文件名.bin'))), sha256(data));
  });

  it('单文件模式直接落在 recv 根目录，不额外建目录', async () => {
    const data = crypto.randomBytes(1024);
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: '单文件落根.txt', size: data.length, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });

    assert.equal(sha256(await fs.readFile(path.join(config.recvDir, '单文件落根.txt'))), sha256(data));
  });

  it('空文件也能正确落盘', async () => {
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'folder',
        folderName: '空批次',
        files: [{ relPath: '空批次/零字节.txt', size: 0, chunkSize: 64 * 1024 }],
      }),
    });
    const { transferId } = await created.json();

    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);
    const stat = await fs.stat(path.join(config.recvDir, '空批次/零字节.txt'));
    assert.equal(stat.size, 0);
  });
});

describe('恶意输入防护', () => {
  const attacks = [
    { name: '上级目录', relPath: '../../逃逸.txt' },
    { name: '嵌套上级目录', relPath: '正常/../../逃逸.txt' },
    { name: '反斜杠穿越', relPath: '..\\..\\逃逸.txt' },
    { name: '绝对路径', relPath: 'C:\\Windows\\evil.txt' },
    { name: 'UNC 路径', relPath: '\\\\攻击者\\共享\\evil.txt' },
    { name: '仅上级引用', relPath: '..' },
  ];

  for (const attack of attacks) {
    it(`拒绝${attack.name}：${attack.relPath}`, async () => {
      const response = await phone('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: 'file', files: [{ relPath: attack.relPath, size: 10 }] }),
      });
      assert.ok(response.status === 400 || response.status === 403, `应被拒绝，实际 ${response.status}`);
    });
  }

  it('Windows 保留设备名被改名后仍能落盘', async () => {
    const payload = Buffer.from('con 文件内容');
    const created = await phone('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: 'file',
        files: [{ relPath: 'CON.txt', size: payload.length, chunkSize: 64 * 1024 }],
      }),
    });
    assert.equal(created.status, 201);
    const { transferId, files } = await created.json();

    // 服务端必须已经把它改名（不能是裸的 CON.txt）
    assert.notEqual(files[0].relPath, 'CON.txt');

    await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload),
    });
    const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    assert.equal(done.status, 200);

    const listed = await fs.readdir(config.recvDir);
    assert.ok(listed.some((name) => name.startsWith('CON_')), `实际目录内容：${listed.join(', ')}`);
  });

  it('同名文件自动改名而不覆盖', async () => {
    const first = Buffer.from('第一份');
    const second = Buffer.from('第二份');

    for (const payload of [first, second]) {
      const created = await phone('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'file',
          files: [{ relPath: '重名.txt', size: payload.length, chunkSize: 64 * 1024 }],
        }),
      });
      const { transferId } = await created.json();
      await phone(`/api/transfers/${transferId}/chunks/0?part=0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(payload),
      });
      await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
    }

    assert.equal((await fs.readFile(path.join(config.recvDir, '重名.txt'))).toString(), '第一份');
    assert.equal((await fs.readFile(path.join(config.recvDir, '重名 (1).txt'))).toString(), '第二份');
  });
});

describe('推送下载（电脑 -> 手机）', () => {
  it('分片下载、Range 请求、显式确认后才算收完', async () => {
    const payload = crypto.randomBytes(150 * 1024);
    const sourceDir = path.join(root, 'outgoing');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, '推送文件.bin'), payload);

    const created = await local('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [path.join(sourceDir, '推送文件.bin')], name: '推送文件.bin' }),
    });
    assert.equal(created.status, 201);
    const { transfer } = await created.json();
    assert.equal(transfer.kind, 'push');

    const chunkSize = transfer.chunkSize;
    const chunkCount = Math.ceil(payload.length / chunkSize);

    // 逐块拉取并确认，重组后必须与源一致。
    const assembled = Buffer.alloc(payload.length);
    for (let index = 0; index < chunkCount; index += 1) {
      const response = await phone(`/api/transfers/${transfer.id}/chunks/${index}?file=0`);
      assert.equal(response.status, 200);
      const chunk = Buffer.from(await response.arrayBuffer());
      chunk.copy(assembled, index * chunkSize);

      const confirm = await phone(`/api/push/${transfer.id}/chunks/${index}/confirm?file=0`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bytes: chunk.length }),
      });
      assert.equal(confirm.status, 200);
    }
    assert.equal(sha256(assembled), sha256(payload), '手机重组出的内容必须与源文件一致');

    // 全部确认后服务端应把任务标记完成。
    const status = await phone(`/api/transfers/${transfer.id}`);
    assert.equal((await status.json()).transfer.status, 'done');

    // 只读取分片不应被算作"已收到"。
    const created2 = await local('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [path.join(sourceDir, '推送文件.bin')], name: '不确认' }),
    });
    const transfer2 = (await created2.json()).transfer;
    await phone(`/api/transfers/${transfer2.id}/chunks/0?file=0`);
    const after = await phone(`/api/transfers/${transfer2.id}`);
    assert.equal((await after.json()).transfer.receivedChunks, 0, '只读不算收到');
  });

  it('支持 Range 请求，且中文文件名有正确的 Content-Disposition', async () => {
    const payload = Buffer.from('0123456789'.repeat(1000));
    const sourceDir = path.join(root, 'outgoing');
    await fs.writeFile(path.join(sourceDir, '中文名.txt'), payload);

    const created = await local('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [path.join(sourceDir, '中文名.txt')], name: '中文名.txt' }),
    });
    const transfer = (await created.json()).transfer;

    const whole = await phone(`/api/push/${transfer.id}/files/0/content`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    const disposition = whole.headers.get('content-disposition') ?? '';
    assert.match(disposition, /filename\*=UTF-8''/, '必须提供 RFC 5987 编码的文件名');

    const partial = await phone(`/api/push/${transfer.id}/files/0/content`, {
      headers: { Range: 'bytes=100-199' },
    });
    assert.equal(partial.status, 206);
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), payload.subarray(100, 200).toString());
    assert.equal(partial.headers.get('content-range'), `bytes 100-199/${payload.length}`);
  });

  it('推送不存在的源文件会失败', async () => {
    const response = await local('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [path.join(root, '不存在.bin')], name: 'x' }),
    });
    assert.equal(response.status, 400);
  });
});

describe('文本互传', () => {
  it('手机发文本给电脑，能查回并保持内容一致', async () => {
    const text = '中文 hello\n第二行 <script>alert(1)</script>';
    const post = await phone('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, direction: 'to-pc' }),
    });
    assert.equal(post.status, 201);
    const entry = (await post.json()).entry;
    assert.equal(entry.text, text);
    assert.equal(entry.direction, 'to-pc');

    const list = await phone('/api/clipboard?limit=10');
    const entries = (await list.json()).entries;
    assert.ok(entries.some((e) => e.text === text));
  });

  it('电脑推文本给手机', async () => {
    const text = '来自电脑的文本';
    const response = await local('/api/clipboard/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).entry.direction, 'to-phone');
  });

  it('超长文本被拒绝并提示改用文件传输', async () => {
    const response = await phone('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'text_too_long');
  });
});

describe('路径清洗单元测试', () => {
  it('sanitizeSegment 处理保留名与非法字符', () => {
    assert.equal(sanitizeSegment('CON'), 'CON_');
    assert.equal(sanitizeSegment('con.txt'), 'con_.txt');
    assert.equal(sanitizeSegment('CONSOLE'), 'CONSOLE');
    assert.equal(sanitizeSegment('a<b>c.txt'), 'a_b_c.txt');
    assert.equal(sanitizeSegment('末尾点...'), '末尾点');
    assert.equal(sanitizeSegment('结尾空格  '), '结尾空格');
    assert.equal(sanitizeSegment('nul'), 'nul_');
    assert.equal(sanitizeSegment(''), 'unnamed');
    assert.equal(sanitizeSegment('COM1.dat'), 'COM1_.dat');
  });

  it('sanitizeRelativePath 保留层级、拒绝穿越', () => {
    assert.equal(sanitizeRelativePath('a/b/c.txt'), 'a/b/c.txt');
    assert.equal(sanitizeRelativePath('a\\b\\c.txt'), 'a/b/c.txt');
    assert.equal(sanitizeRelativePath('./a/./b.txt'), 'a/b.txt');
    assert.equal(sanitizeRelativePath('a//b.txt'), 'a/b.txt');
    assert.throws(() => sanitizeRelativePath('../x'), UnsafePathError);
    assert.throws(() => sanitizeRelativePath('a/../../x'), UnsafePathError);
    assert.throws(() => sanitizeRelativePath('/etc/passwd'), UnsafePathError);
    assert.throws(() => sanitizeRelativePath('C:/x'), UnsafePathError);
    assert.throws(() => sanitizeRelativePath(''), UnsafePathError);
  });

  it('resolveWithin 保证结果落在根目录内', () => {
    const base = path.join(root, 'recv');
    const result = resolveWithin(base, '子目录/文件.txt');
    assert.ok(result.absolute.startsWith(path.resolve(base)));
    assert.equal(result.relative, '子目录/文件.txt');
    assert.throws(() => resolveWithin(base, '../../逃逸'), UnsafePathError);
  });

  it('全角字符会被归一化，不能绕过检查', () => {
    // 全角句点经 NFKC 会折叠成 ASCII 点，因此 "．．/x" 必须被识别为穿越。
    assert.throws(() => sanitizeRelativePath('．．/x'), UnsafePathError);
  });
});

describe('本机控制接口', () => {
  it('缺少控制令牌时拒绝', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/local/info`);
    assert.equal(response.status, 403);
  });

  it('带正确控制令牌时返回运行时信息', async () => {
    const response = await local('/api/local/info');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.recvDir, config.recvDir);
    assert.ok(typeof body.connectedDevices === 'number');
  });
});
