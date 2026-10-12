/**
 * P0 验收脚本。
 *
 * 走的是"真实用户会走的路径"：真的把服务起在局域网上、真的按网页地址取静态资源、
 * 真的传 1GB、真的比对哈希、真的做断点续传（模拟手机中断后带位图重连）。
 *
 * 注意：这一版刻意走 HTTP 全流程而不是复用内部对象，
 * 因为要验证的正是"网络这一层有没有问题"。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE = 'file:///E:/dsh_project/dropsend/src/';
const { buildConfig } = await import(`${BASE}config.ts`);
const { startServer } = await import(`${BASE}server.ts`);
const { listLanAddresses } = await import(`${BASE}lib/net.ts`);

const GIB = 1024 ** 3;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${detail}`);
}

const root = path.join(os.tmpdir(), `dropsend-accept-${crypto.randomBytes(4).toString('hex')}`);
const base = buildConfig({ command: 'serve', positional: [], flags: new Map() });
const config = {
  ...base,
  host: '0.0.0.0',
  port: 0,
  loopbackOnly: false,
  recvDir: path.join(root, 'recv'),
  stateDir: path.join(root, 'state'),
  chunkSize: 8 * 1024 * 1024,
  maxFileSize: 8 * GIB,
  syncClipboard: true,
  pairTtlMs: 600_000,
};

console.log('启动服务（监听 0.0.0.0，模拟真实使用）…');
const server = await startServer({ config, log: () => {} });
const LAN = listLanAddresses()[0]?.address ?? '127.0.0.1';
const PORT = server.port;
console.log(`监听端口 ${PORT}，局域网地址 ${LAN}\n`);

// --- 1. 局域网可达性 + 静态资源 ---------------------------------------------
try {
  const page = await fetch(`http://${LAN}:${PORT}/`);
  const html = await page.text();
  const js = await fetch(`http://${LAN}:${PORT}/app.js`);
  const css = await fetch(`http://${LAN}:${PORT}/style.css`);
  const ok = page.status === 200 && html.includes('dropsend') && js.status === 200 && css.status === 200;
  record('局域网访问 + 静态资源', ok, `页面 ${page.status} (${html.length}B) · app.js ${js.status} · style.css ${css.status}`);
} catch (error) {
  record('局域网访问 + 静态资源', false, `失败：${error.message}`);
}

// --- 2. PIN 配对 ------------------------------------------------------------
let cookie = '';
let pairedToken = '';
try {
  const wrong = await fetch(`http://${LAN}:${PORT}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: server.oneTimeToken, pin: '000001' }),
  });
  const right = await fetch(`http://${LAN}:${PORT}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
  });
  cookie = (right.headers.getSetCookie()[0] ?? '').split(';')[0];
  pairedToken = server.oneTimeToken;
  record('PIN 配对（错 PIN 拒绝、对 PIN 通过）', wrong.status === 401 && right.status === 200,
    `错误 PIN → ${wrong.status}，正确 PIN → ${right.status}，Cookie ${cookie ? '已下发' : '缺失'}`);
} catch (error) {
  record('PIN 配对', false, `失败：${error.message}`);
}

const phone = (p, o = {}) => fetch(`http://${LAN}:${PORT}${p}`, { ...o, headers: { Cookie: cookie, ...(o.headers ?? {}) } });

/**
 * 电脑侧（CLI 视角）的请求。
 *
 * 必须走 127.0.0.1：控制令牌在服务端只对回环地址生效，
 * 这是刻意设计——手机拿不到 runtime.json，也就拿不到这个令牌。
 * 用局域网 IP 发会（正确地）被 403 拒绝。
 */
const pc = (p, o = {}) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...o,
    headers: { 'X-Drop-Token': server.controlToken, ...(o.headers ?? {}) },
  });

// --- 2b. 控制令牌的边界：非回环地址必须被拒 --------------------------------
try {
  const viaLan = await fetch(`http://${LAN}:${PORT}/api/local/info`, {
    headers: { 'X-Drop-Token': server.controlToken },
  });
  // LAN === 127.0.0.1 时（无外网网卡）这项不适用，视为通过。
  const ok = LAN === '127.0.0.1' ? true : viaLan.status === 403;
  record('控制令牌只对回环地址生效', ok,
    LAN === '127.0.0.1' ? '无局域网网卡，跳过' : `经 ${LAN} 携带令牌 → ${viaLan.status}（应为 403）`);
} catch (error) {
  record('控制令牌边界', false, `失败：${error.message}`);
}

try {
  const SIZE = GIB;
  const chunkSize = config.chunkSize;
  const chunkCount = Math.ceil(SIZE / chunkSize);

  // 边生成边算哈希，避免再存一份 1GB。
  const srcPath = path.join(root, 'big.bin');
  const hash = crypto.createHash('sha256');
  {
    const handle = await fs.open(srcPath, 'w');
    const block = crypto.randomBytes(chunkSize);
    try {
      for (let i = 0; i < chunkCount; i += 1) {
        const len = Math.min(chunkSize, SIZE - i * chunkSize);
        const slice = block.subarray(0, len);
        await handle.write(slice, 0, len, i * chunkSize);
        hash.update(slice);
      }
    } finally { await handle.close(); }
  }
  const srcDigest = hash.digest('hex');

  const created = await phone('/api/transfers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'file',
      files: [{ relPath: '1GB测试.bin', size: SIZE, sha256: srcDigest, chunkSize }],
    }),
  });
  const { transferId } = await created.json();

  const started = Date.now();
  let uploaded = 0;
  // 并发 4，和手机端默认值一致。
  const indexes = Array.from({ length: chunkCount }, (_, i) => i);
  let cursor = 0;
  const worker = async () => {
    while (cursor < indexes.length) {
      const i = indexes[cursor++];
      const len = Math.min(chunkSize, SIZE - i * chunkSize);
      const buf = Buffer.alloc(len);
      const fh = await fs.open(srcPath, 'r');
      try { await fh.read(buf, 0, len, i * chunkSize); } finally { await fh.close(); }
      const res = await phone(`/api/transfers/${transferId}/chunks/${i}?part=0`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(buf),
      });
      if (!res.ok) throw new Error(`分片 ${i} 失败：${res.status} ${await res.text()}`);
      uploaded += len;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const elapsed = (Date.now() - started) / 1000;

  const done = await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });
  if (!done.ok) throw new Error(`完成失败：${await done.text()}`);

  const landed = await fs.readFile(path.join(config.recvDir, '1GB测试.bin'));
  const landedDigest = crypto.createHash('sha256').update(landed).digest('hex');

  const throughput = (SIZE / (1024 * 1024)) / elapsed;
  record('1GB 文件传输 + SHA-256 一致', landedDigest === srcDigest && landed.length === SIZE,
    `${(SIZE / GIB).toFixed(2)} GiB，用时 ${elapsed.toFixed(1)}s，${throughput.toFixed(0)} MiB/s，哈希 ${landedDigest === srcDigest ? '一致' : '不一致！'}`);
} catch (error) {
  record('1GB 文件传输 + SHA-256 一致', false, `失败：${error.message}`);
}

// --- 4. 断点续传：中断后带位图重连 ------------------------------------------
try {
  const SIZE = 40 * 1024 * 1024;
  const chunkSize = config.chunkSize;
  const payload = crypto.randomBytes(SIZE);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const chunkCount = Math.ceil(SIZE / chunkSize);

  const created = await phone('/api/transfers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'file', files: [{ relPath: '续传.bin', size: SIZE, sha256: digest, chunkSize }] }),
  });
  const { transferId } = await created.json();

  // 只传前两块，模拟锁屏中断。
  for (const i of [0, 1]) {
    await phone(`/api/transfers/${transferId}/chunks/${i}?part=0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload.subarray(i * chunkSize, (i + 1) * chunkSize)),
    });
  }

  // 手机"回到前台"：问服务器已收到哪些块。
  const resume = await phone(`/api/transfers/${transferId}`);
  const info = await resume.json();
  const alreadyHave = info.received[0].received;

  // 只补剩下的。
  for (let i = 0; i < chunkCount; i += 1) {
    if (alreadyHave.includes(i)) continue;
    await phone(`/api/transfers/${transferId}/chunks/${i}?part=0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload.subarray(i * chunkSize, Math.min(SIZE, (i + 1) * chunkSize))),
    });
  }
  await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });

  const landed = await fs.readFile(path.join(config.recvDir, '续传.bin'));
  const landedDigest = crypto.createHash('sha256').update(landed).digest('hex');
  record('断点续传（中断 → 查位图 → 补传 → 哈希一致）',
    alreadyHave.length === 2 && landedDigest === digest,
    `已收位图 ${JSON.stringify(alreadyHave)}，补传 ${chunkCount - alreadyHave.length} 块，最终哈希${landedDigest === digest ? '一致' : '不一致！'}`);
} catch (error) {
  record('断点续传', false, `失败：${error.message}`);
}

// --- 5. 文件夹结构还原 ------------------------------------------------------
try {
  // 浏览器给出的 webkitRelativePath 以文件夹名开头，这里如实模拟。
  const files = [
    { rel: '相册/2024/照片一.jpg', size: 5000 },
    { rel: '相册/2024/照片二.jpg', size: 7000 },
    { rel: '相册/说明.txt', size: 300 },
  ];
  const created = await phone('/api/transfers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'folder', folderName: '相册',
      emptyDirs: ['相册/空文件夹'],
      files: files.map((f) => ({ relPath: f.rel, size: f.size, chunkSize: 64 * 1024 })),
    }),
  });
  const { transferId } = await created.json();

  for (const [i, f] of files.entries()) {
    const buf = crypto.randomBytes(f.size);
    await phone(`/api/transfers/${transferId}/chunks/0?part=${i}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(buf),
    });
    await phone('/api/transfers/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, partIndex: i }),
    });
  }
  await phone(`/api/transfers/${transferId}/complete`, { method: 'POST', body: '{}' });

  const checks = await Promise.all([
    fs.stat(path.join(config.recvDir, '相册/2024/照片一.jpg')),
    fs.stat(path.join(config.recvDir, '相册/2024/照片二.jpg')),
    fs.stat(path.join(config.recvDir, '相册/说明.txt')),
    fs.stat(path.join(config.recvDir, '相册/空文件夹')),
  ]);
  const noDoubleNesting = await fs
    .access(path.join(config.recvDir, '相册/相册'))
    .then(() => false)
    .catch(() => true);
  record('文件夹整体传输（含中文名、嵌套目录、空目录）',
    checks[0].size === 5000 && checks[1].size === 7000 && checks[2].size === 300
      && checks[3].isDirectory() && noDoubleNesting,
    `还原到 recv/相册/ 下：3 个文件（${checks.map((c) => c.size).join('/')} 字节）+ 1 个空目录，无重复嵌套=${noDoubleNesting}`);
} catch (error) {
  record('文件夹整体传输', false, `失败：${error.message}`);
}

// --- 6. 推送下载 + 显式确认 -------------------------------------------------
try {
  const payload = crypto.randomBytes(20 * 1024 * 1024);
  const srcPath = path.join(root, '推送.bin');
  await fs.writeFile(srcPath, payload);

  const created = await pc('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePaths: [srcPath], name: '推送.bin' }),
  });
  const { transfer } = await created.json();
  const chunkSize = transfer.chunkSize;

  const assembled = Buffer.alloc(payload.length);
  const n = Math.ceil(payload.length / chunkSize);
  for (let i = 0; i < n; i += 1) {
    const res = await phone(`/api/transfers/${transfer.id}/chunks/${i}?file=0`);
    const buf = Buffer.from(await res.arrayBuffer());
    buf.copy(assembled, i * chunkSize);
    await phone(`/api/push/${transfer.id}/chunks/${i}/confirm?file=0`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: buf.length }),
    });
  }

  const status = await (await phone(`/api/transfers/${transfer.id}`)).json();
  record('电脑→手机 推送下载（分片重组 + 显式确认后标记完成）',
    assembled.equals(payload) && status.transfer.status === 'done',
    `${n} 个分片重组一致，任务状态 ${status.transfer.status}`);
} catch (error) {
  record('电脑→手机 推送下载', false, `失败：${error.message}`);
}

// --- 7. 文本互传（含写入系统剪贴板的能力探测） ------------------------------
try {
  const text = `验收测试文本 ${new Date().toISOString()} 换行\n第二行`;
  const sent = await phone('/api/clipboard', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, direction: 'to-pc' }),
  });
  const entry = (await sent.json()).entry;

  const listed = await (await phone('/api/clipboard?limit=5')).json();
  const found = listed.entries.find((e) => e.text === text);

  const published = await pc('/api/clipboard/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '回给手机的文本' }),
  });

  record('文本互传（手机→电脑、电脑→手机）',
    sent.status === 201 && Boolean(found) && published.status === 201,
    `手机→电脑 内容一致=${Boolean(found)}，写入系统剪贴板=${entry.writtenToSystem ? '成功' : '被环境禁止（文本仍已保存）'}，电脑→手机 ${published.status}`);
} catch (error) {
  record('文本互传', false, `失败：${error.message}`);
}

// --- 8. 恶意路径防护 --------------------------------------------------------
try {
  const attacks = ['../../逃逸.txt', '正常/../../逃逸.txt', '..\\..\\逃逸.txt', 'C:\\Windows\\evil.txt'];
  const codes = [];
  for (const relPath of attacks) {
    const res = await phone('/api/transfers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'file', files: [{ relPath, size: 10 }] }),
    });
    codes.push(res.status);
  }
  // 逃逸文件绝不能出现在接收目录之外。
  const parentLeak = await fs.access(path.join(root, '逃逸.txt')).then(() => true).catch(() => false);
  record('恶意相对路径防护', codes.every((c) => c === 400 || c === 403) && !parentLeak,
    `${attacks.length} 种攻击全部拒绝（状态码 ${codes.join('/')}），无文件逃逸出接收目录`);
} catch (error) {
  record('恶意相对路径防护', false, `失败：${error.message}`);
}

// --- 9. 未配对访问被拒 ------------------------------------------------------
try {
  const res = await fetch(`http://${LAN}:${PORT}/api/transfers`);
  record('未配对访问受保护接口被拒', res.status === 401, `状态码 ${res.status}`);
} catch (error) {
  record('未配对访问被拒', false, `失败：${error.message}`);
}

// --- 汇总 -------------------------------------------------------------------
await server.stop();
await fs.rm(root, { recursive: true, force: true }).catch(() => {});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'─'.repeat(60)}`);
console.log(`验收结果：${passed}/${results.length} 项通过`);
for (const r of results) if (!r.ok) console.log(`  未通过：${r.name} —— ${r.detail}`);
process.exit(passed === results.length ? 0 : 1);
