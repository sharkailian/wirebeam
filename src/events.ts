/**
 * 事件总线：传给手机端的实时进度。
 *
 * 用 SSE 而不是 WebSocket，理由：
 *  - 原生 http 直接支持，不需要手写握手/掩码/分帧
 *  - 浏览器自带断线重连，并会带上 Last-Event-ID
 *  - 传输进度是"服务器 -> 手机"单向推送，SSE 正好
 *
 * 事件只保留最近 N 条；如果客户端重连时错过了事件（Last-Event-ID 落后于
 * 缓冲区起点），就补发一条 `resync`，让前端重新拉一次全量状态。
 */

import type { ServerResponse } from 'node:http';

export interface BusEvent {
  id: number;
  type: string;
  data: unknown;
}

const BUFFER_SIZE = 300;

export class EventBus {
  private readonly clients = new Set<ServerResponse>();
  private readonly buffer: BusEvent[] = [];
  private nextId = 1;

  /** 订阅；返回取消订阅函数。 */
  subscribe(res: ServerResponse, lastEventId?: number): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);

    // 补发错过的内容。
    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      const oldest = this.buffer[0]?.id ?? this.nextId;
      if (lastEventId + 1 < oldest) {
        this.writeTo(res, { id: this.nextId++, type: 'resync', data: { reason: 'missed_events' } });
      } else {
        for (const event of this.buffer) {
          if (event.id > lastEventId) this.writeTo(res, event);
        }
      }
    }

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 20_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);

    return cleanup;
  }

  /** 广播一个事件。 */
  emit(type: string, data: unknown): BusEvent {
    const event: BusEvent = { id: this.nextId++, type, data };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();

    for (const client of [...this.clients]) {
      this.writeTo(client, event);
    }
    return event;
  }

  get subscriberCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        // 忽略：连接可能已经断开。
      }
    }
    this.clients.clear();
  }

  private writeTo(res: ServerResponse, event: BusEvent): void {
    try {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }
}
