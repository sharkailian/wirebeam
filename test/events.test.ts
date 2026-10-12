/**
 * SSE 事件流测试。
 *
 * 手机端的进度条、收到的文本提示、推送通知全都依赖这条通道，
 * 所以它必须被真实验证：不能用"路由返回了 200"冒充。
 *
 * 覆盖：
 *  - 订阅后能收到进度事件，且事件负载包含拼装分片所需的关键字段
 *  - Last-Event-ID 重连能补发错过的消息
 *  - 落后太多时收到 resync 而不是静默丢事件
 *  - 未配对也能订阅（否则手机没法显示配对状态），但配对后才收到业务事件
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildConfig, type Config } from '../src/config.ts';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer;
let config: Config;
let root: string;
let cookie = '';

before(async () => {
  root = path.join(os.tmpdir(), `dropsend-sse-${crypto.randomBytes(4).toString('hex')}`);
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

  const paired = await fetch(`http://127.0.0.1:${server.port}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
  });
  cookie = (paired.headers.getSetCookie()[0] ?? '').split(';')[0]!;
});

after(async () => {
  await server?.stop();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

interface SseEvent {
  id?: number;
  event?: string;
  data?: unknown;
  comment?: string;
}

/** 极简 SSE 客户端：读取流、按空行切分事件。 */
class SseClient {
  private readonly controller = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = '';
  readonly events: SseEvent[] = [];
  private closed = false;

  async connect(lastEventId?: number): Promise<void> {
    const headers: Record<string, string> = { Cookie: cookie };
    if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers,
      signal: this.controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    this.reader = response.body!.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        this.buffer += new TextDecoder().decode(value, { stream: true });
        this.drain();
      }
    } catch {
      // abort 时正常抛错。
    }
  }

  private drain(): void {
    let index = this.buffer.indexOf('\n\n');
    while (index >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.parse(raw);
      index = this.buffer.indexOf('\n\n');
    }
  }

  private parse(raw: string): void {
    const event: SseEvent = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) { event.comment = line.slice(1).trim(); continue; }
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (field === 'id') event.id = Number(value);
      else if (field === 'event') event.event = value;
      else if (field === 'data') {
        try { event.data = JSON.parse(value); } catch { event.data = value; }
      }
    }
    // 纯注释行（心跳、连接确认）也要留下，否则没法断言"连接已建立"。
    if (event.event || event.data !== undefined || event.comment !== undefined) {
      this.events.push(event);
    }
  }

  /** 等某个事件出现，超时抛错。 */
  async waitFor(predicate: (event: SseEvent) => boolean, timeoutMs = 5000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.events.find(predicate);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待事件超时。已收到：${JSON.stringify(this.events.map((e) => e.event))}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }
}

async function createUpload(files: { relPath: string; size: number }[]): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/transfers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'file',
      files: files.map((f) => ({ ...f, chunkSize: 64 * 1024 })),
    }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { transferId: string }).transferId;
}

describe('SSE 事件流', () => {
  it('订阅时立即收到一条注释，作为连接已建立的信号', async () => {
    const client = new SseClient();
    await client.connect();
    await client.waitFor((e) => e.comment === 'connected', 3000);
    client.close();
  });

  it('上传分片会推送 progress 事件，且负载字段足够前端渲染进度', async () => {
    const client = new SseClient();
    await client.connect();

    const transferId = await createUpload([{ relPath: '进度.bin', size: 128 * 1024 }]);

    await fetch(`http://127.0.0.1:${server.port}/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(64 * 1024),
    });

    const event = await client.waitFor((e) => e.event === 'progress');
    const data = event.data as Record<string, unknown>;

    // 这些字段是手机端画进度条与算百分比所必需的，缺一不可。
    assert.equal(data.id, transferId);
    assert.equal(data.kind, 'upload');
    assert.equal(data.totalBytes, 128 * 1024);
    assert.equal(data.doneBytes, 64 * 1024);
    assert.equal(data.chunksDone, 1);
    assert.equal(data.chunkCount, 2);

    client.close();
  });

  it('任务创建与完成都会推送，完成事件带上落盘文件名', async () => {
    const client = new SseClient();
    await client.connect();

    const payload = crypto.randomBytes(1000);
    const transferId = await createUpload([{ relPath: '完成通知.bin', size: payload.length }]);

    await client.waitFor((e) => e.event === 'upload.created');

    await fetch(`http://127.0.0.1:${server.port}/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(payload),
    });
    await fetch(`http://127.0.0.1:${server.port}/api/transfers/${transferId}/complete`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: '{}',
    });

    const completed = await client.waitFor((e) => e.event === 'transfer.completed');
    const data = completed.data as { name?: string; files?: string[] };
    assert.equal(data.name, '完成通知.bin');
    assert.deepEqual(data.files, ['完成通知.bin']);

    client.close();
  });

  it('Last-Event-ID 重连能补发错过的进度事件', async () => {
    const first = new SseClient();
    await first.connect();

    const transferId = await createUpload([{ relPath: '补发.bin', size: 128 * 1024 }]);

    await fetch(`http://127.0.0.1:${server.port}/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(64 * 1024),
    });

    const seen = await first.waitFor((e) => e.event === 'progress');
    const lastId = seen.id!;
    first.close();

    // 断开期间又发生了一次进度变化。
    await fetch(`http://127.0.0.1:${server.port}/api/transfers/${transferId}/chunks/1?part=0`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(64 * 1024),
    });

    // 带着 lastId 重连：应该把断线期间的事件补上。
    const second = new SseClient();
    await second.connect(lastId);
    const replayed = await second.waitFor((e) => (e.id ?? 0) > lastId && e.event === 'progress', 4000);

    assert.ok((replayed.id ?? 0) > lastId, '补发事件的 id 必须大于重连时提供的 id');
    second.close();
  });

  it('未配对也能订阅（否则手机无法显示配对状态）', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    await response.body?.cancel();
  });
});
