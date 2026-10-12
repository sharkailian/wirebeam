/**
 * 服务器装配。
 *
 * 职责：
 *  - 建库（状态层 + 传输引擎）、开配对窗口、监听端口（被占用自动顺延）
 *  - 把请求分派给 /api 路由或静态资源
 *  - 周期性维护：清理过期会话、清理过期任务元数据、清理孤儿分片
 *  - 优雅关停：Ctrl+C 时先停止接受新连接，再落盘状态
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from './config.ts';
import { EventBus } from './events.ts';
import { findAvailablePort, listLanAddresses, pickLanAddress } from './lib/net.ts';
import { serveStatic } from './lib/static.ts';
import { Pairing } from './pairing.ts';
import { StateStore, writeJsonAtomic } from './store.ts';
import { TransferEngine } from './transfer.ts';
import { clientAddress, handleApi, hostName, type RouteContext, type RuntimeInfo } from './routes.ts';

const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;

/** web/ 目录位置：相对本文件（src/server.ts）→ ../web。 */
export function webDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'web');
}

export interface RunningServer {
  url: string;
  port: number;
  pin: string;
  oneTimeToken: string;
  pairingExpiresAt: number;
  addresses: { address: string; iface: string }[];
  /** 仅限本机的控制令牌，供同进程内的自检使用。 */
  controlToken: string;
  stop: () => Promise<void>;
  context: RouteContext;
}

export interface StartOptions {
  config: Config;
  log: (message: string) => void;
  /** 覆盖监听端口（已经在外部探测过时用）。 */
  port?: number;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { config, log } = options;

  const store = new StateStore(config.stateDir);
  await store.init();

  const engine = new TransferEngine(config, store);
  await engine.init();

  const bus = new EventBus();
  const pairing = new Pairing(config.pairTtlMs);
  const pairState = pairing.open();

  const address = config.advertisedHost
    ? { address: config.advertisedHost, iface: '手动指定' }
    : (pickLanAddress() ?? { address: '127.0.0.1', iface: '本机' });

  const requestedPort = options.port ?? config.port;
  // port 0 表示"由系统分配"，此时不能走顺延探测（0 永远可绑定），
  // 必须先监听再向 socket 问实际端口。
  const wantsEphemeral = requestedPort === 0;
  const port = wantsEphemeral ? 0 : await findAvailablePort(config.host, requestedPort);

  const server = http.createServer();

  /**
   * 仅限本机的控制令牌：`drop send` / `drop clip` 用它证明"我是本机的 CLI"，
   * 而无需伪造会话 Cookie。服务端只接受来自 127.0.0.1 且携带它的请求，
   * 手机端拿不到也用不上。
   */
  const controlToken = crypto.randomBytes(24).toString('base64url');

  let runtime: RuntimeInfo;

  const context: RouteContext = {
    config,
    store,
    engine,
    pairing,
    bus,
    // 监听成功后会被替换成含真实端口的对象；这里先占位。
    runtime: undefined as unknown as RuntimeInfo,
    log,
    shutdown: () => {
      void stop();
    },
    controlToken,
  };

  server.on('request', (req, res) => {
    void handleRequest(req, res, context);
  });

  // 长连接上传/下载：把超时放宽，否则大文件会被默认 2 分钟掐断。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: config.host, port }, () => resolve());
  });

  // 真实端口：port 为 0 时必须从 socket 读回来，否则地址栏里会出现 :0。
  const actualPort = (() => {
    const info = server.address();
    if (info && typeof info === 'object') return info.port;
    return port;
  })();

  runtime = {
    startedAt: Date.now(),
    advertisedHost: address.address,
    advertisedUrl: `http://${formatHost(address.address)}:${actualPort}/`,
    hostName: hostName(),
  };
  context.runtime = runtime;

  // 上次没传完的任务：让手机端还能看到并继续。
  const resurrected = store.resurrectActive();
  if (resurrected.length > 0) {
    log(`发现 ${resurrected.length} 个未完成的传输任务，手机重新进入后可以继续。`);
  }
  const orphanParts = await engine.sweepOrphanParts();
  if (orphanParts > 0) log(`清理了 ${orphanParts} 个孤儿分片目录。`);

  const housekeeping = setInterval(() => {
    void runHousekeeping(context);
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref?.();

  /**
   * 把运行时信息写进状态目录，供 `drop send` / `drop clip` 这类
   * 本地 CLI 命令找到正在运行的服务。
   */
  await writeJsonAtomic(path.join(config.stateDir, 'runtime.json'), {
    port: actualPort,
    url: runtime.advertisedUrl,
    host: config.host,
    pid: process.pid,
    startedAt: runtime.startedAt,
    controlToken,
    recvDir: config.recvDir,
    hostName: runtime.hostName,
  });

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(housekeeping);
    bus.closeAll();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 有活跃长连接时 close 不会立刻返回，给 3 秒然后强制断开。
      setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 3000).unref?.();
    });

    await store.close();
    await fs.rm(path.join(config.stateDir, 'runtime.json'), { force: true }).catch(() => {});
  }

  // Ctrl+C：先关服务再退出，保证状态落盘。
  const onSignal = () => {
    log('正在停止服务……');
    void stop().then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    url: runtime.advertisedUrl,
    port: actualPort,
    pin: pairState.pin,
    oneTimeToken: pairState.oneTimeToken,
    pairingExpiresAt: pairState.expiresAt,
    addresses: listLanAddresses().map((c) => ({ address: c.address, iface: c.iface })),
    controlToken,
    stop,
    context,
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const started = Date.now();
  const url = req.url ?? '/';

  // 所有响应都带上基础安全头。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  try {
    const result = await handleApi(req, res, ctx);
    if (result.handled) {
      if (ctx.config.verbose) logRequest(ctx, req, res, started);
      return;
    }

    const pathname = new URL(url, 'http://localhost').pathname;
    const served = await serveStatic(req, res, pathname, { root: webDir() });
    if (served) {
      if (ctx.config.verbose) logRequest(ctx, req, res, started);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 未找到\n');
  } catch (error) {
    // 兜底：任何未捕获的错误都不能让进程挂掉。
    ctx.log(`请求处理失败：${(error as Error).message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'internal', error: '服务器内部错误' }));
    } else {
      res.end();
    }
  }
}

function logRequest(ctx: RouteContext, req: http.IncomingMessage, res: http.ServerResponse, started: number): void {
  const ms = Date.now() - started;
  const from = clientAddress(req) ?? '-';
  ctx.log(`${req.method} ${req.url} → ${res.statusCode} (${ms}ms, ${from})`);
}

async function runHousekeeping(ctx: RouteContext): Promise<void> {
  try {
    const now = Date.now();
    const sessions = await ctx.store.pruneSessions(now);
    const removed = await ctx.store.prune(cutoffRetention(ctx.config.retentionMs, now));

    // 被清理的任务，其临时分片也要删掉。
    if (removed.length > 0) {
      await ctx.engine.sweepOrphanParts();
    }

    if (sessions > 0 || removed.length > 0) {
      ctx.log(`维护完成：清理 ${sessions} 个过期会话、${removed.length} 个过期任务。`);
    }
    await ctx.store.flush();
  } catch (error) {
    ctx.log(`维护任务出错：${(error as Error).message}`);
  }
}

function cutoffRetention(retentionMs: number, now: number): number {
  return now - retentionMs;
}

/** IPv6 地址放进 URL 需要方括号。 */
export function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/** 确认 web/ 目录存在，缺失时给出可操作的报错。 */
export async function assertWebAssets(): Promise<void> {
  const dir = webDir();
  try {
    await fs.access(path.join(dir, 'index.html'));
  } catch {
    throw new Error(`缺少静态资源：${path.join(dir, 'index.html')} 不存在`);
  }
}
