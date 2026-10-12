/**
 * HTTP 路由。
 *
 * 约定：
 *  - 所有写操作都要求会话 Cookie；配对相关接口除外（否则没法配对）
 *  - 错误统一为 `{ ok: false, code, error }`，HTTP 状态码与语义一致
 *  - 大 body 一律限长，绝不无界缓冲
 *  - 相对路径全部交给 fs-safety 处理，路由层不做任何"自己清洗"
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { MAX_INLINE_TEXT, type Config } from './config.ts';
import { readClipboardText, writeClipboardText } from './clipboard.ts';
import { EventBus } from './events.ts';
import { Pairing, parseCookies, timingSafeEqual } from './pairing.ts';
import { StateStore, newId, type ClipboardEntry, type TransferRecord } from './store.ts';
import { TransferEngine, TransferError } from './transfer.ts';
import { UnsafePathError } from './lib/fs-safety.ts';

export const SESSION_COOKIE = 'ds_session';
const SESSION_TTL_MS = 24 * 3600_000;
const MAX_JSON_BODY = 4 * 1024 * 1024;
const MAX_CHUNK_BODY = 64 * 1024 * 1024;

export interface RuntimeInfo {
  startedAt: number;
  /** 手机应当访问的地址，例如 http://192.168.1.5:8787/ */
  advertisedUrl: string;
  advertisedHost: string;
  /** 本机名，仅用于展示。 */
  hostName: string;
}

export interface RouteContext {
  config: Config;
  store: StateStore;
  engine: TransferEngine;
  pairing: Pairing;
  bus: EventBus;
  runtime: RuntimeInfo;
  /** 启动时打印提示（例如剪贴板被环境禁用）。 */
  log: (message: string) => void;
  /** 请求停止服务（用于 /api/system/shutdown 的本地调用）。 */
  shutdown: () => void;
  /**
   * 仅限本机的控制令牌。`drop send` / `drop clip` 用它证明"我是本机的 CLI"，
   * 而无需伪造会话 Cookie。手机端拿不到这个值。
   */
  controlToken?: string;
}

export interface RouteResult {
  handled: boolean;
}

/** 记录每个任务上次广播进度的时间，做节流。 */
const lastProgressEmit = new Map<string, number>();
const PROGRESS_INTERVAL_MS = 200;

/**
 * 处理 /api/* 请求。返回 `{ handled: false }` 表示不是 API 请求，
 * 交给静态资源处理。
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<RouteResult> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return { handled: false };

  const method = (req.method ?? 'GET').toUpperCase();

  try {
    switch (`${method} ${pathname}`) {
      // --- 配对 -------------------------------------------------------------
      case 'GET /api/pair/info': {
        const status = ctx.pairing.status();
        safeJson(res, 200, {
          ok: true,
          rotation: status.active ? '0' : 'closed',
          active: status.active,
          expiresAt: status.expiresAt,
          secondsLeft: status.secondsLeft,
          attemptsLeft: status.attemptsLeft,
          requiresPin: true,
        });
        return { handled: true };
      }

      case 'POST /api/session': {
        const body = await readJsonBody<{ pin?: string; token?: string }>(req, 64 * 1024);
        if (!body) return badRequest(res, 'bad_json', '请求体不是合法 JSON');

        const result = await ctx.pairing.pair(
          String(body.token ?? ''),
          String(body.pin ?? ''),
          {
            userAgent: req.headers['user-agent'],
            remoteAddress: clientAddress(req),
          },
          ctx.config.sessionTtlMs || SESSION_TTL_MS,
        );

        if (!result.ok) {
          const message = PAIR_MESSAGES[result.reason];
          const status = result.reason === 'too_many_attempts' ? 429 : 401;
          ctx.bus.emit('pair.failed', { reason: result.reason, at: Date.now() });
          safeJson(res, status, { ok: false, code: result.reason, error: message });
          return { handled: true };
        }

        await ctx.store.addSession({
          token: result.sessionToken,
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          expiresAt: result.expiresAt,
          userAgent: req.headers['user-agent'],
          ...(clientAddress(req) ? { remoteAddress: clientAddress(req) } : {}),
        });

        ctx.log(`手机已连接（${clientAddress(req) ?? '未知地址'}）`);
        ctx.bus.emit('session.opened', {
          at: Date.now(),
          remoteAddress: clientAddress(req) ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        });

        res.setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
            (ctx.config.sessionTtlMs || SESSION_TTL_MS) / 1000,
          )}`,
        );
        safeJson(res, 200, { ok: true, expiresAt: result.expiresAt });
        return { handled: true };
      }

      case 'GET /api/session': {
        const session = authenticate(req, ctx);
        if (!session) return unauthorized(res);
        safeJson(res, 200, { ok: true, expiresAt: session.expiresAt, label: session.label ?? null });
        return { handled: true };
      }

      case 'DELETE /api/session': {
        const token = cookieToken(req);
        if (token) await ctx.store.dropSession(token);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        safeJson(res, 200, { ok: true });
        return { handled: true };
      }

      // --- 实时事件（未配对也允许订阅，只推送配对状态） ----------------------
      case 'GET /api/events': {
        const lastEventId = parseLastEventId(req);
        const unsubscribe = ctx.bus.subscribe(res, lastEventId);
        req.on('close', unsubscribe);
        return { handled: true };
      }

      // --- 系统状态 ---------------------------------------------------------
      case 'GET /api/system/status': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const snapshot = ctx.store.listTransfers();
        safeJson(res, 200, {
          ok: true,
          url: ctx.runtime.advertisedUrl,
          hostName: ctx.runtime.hostName,
          recvDir: ctx.config.recvDir,
          chunkSize: ctx.config.chunkSize,
          connectedDevices: ctx.bus.subscriberCount,
          clipboardSync: ctx.config.syncClipboard,
          transfers: {
            active: snapshot.filter((t) => t.status === 'active').length,
            done: snapshot.filter((t) => t.status === 'done').length,
          },
        });
        return { handled: true };
      }

      case 'GET /api/system/stats': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const disk = await diskSpace(ctx.config.recvDir);
        safeJson(res, 200, { ok: true, ...disk, recvDir: ctx.config.recvDir });
        return { handled: true };
      }

      // --- 上传（手机 -> 电脑） --------------------------------------------
      case 'POST /api/transfers': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        return await createUpload(req, res, ctx);
      }

      case 'POST /api/transfers/commit': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const body = await readJsonBody<{ transferId?: string; partIndex?: number }>(req, 64 * 1024);
        if (!body?.transferId || !Number.isInteger(body.partIndex)) {
          return badRequest(res, 'bad_json', '需要 transferId 与 partIndex');
        }
        const part = await ctx.engine.completePart(body.transferId, body.partIndex as number);
        const record = ctx.store.getUpload(body.transferId);
        emitTransfer(ctx, record);
        safeJson(res, 200, {
          ok: true,
          part: {
            index: body.partIndex,
            relPath: part.storedName ?? part.relPath,
            bytes: part.receivedBytes,
            sha256: part.sha256 ?? null,
          },
        });
        return { handled: true };
      }

      case 'GET /api/transfers': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const list = ctx.store.listTransfers().map((record) => summarize(record));
        safeJson(res, 200, { ok: true, transfers: list });
        return { handled: true };
      }

      // --- 推送（电脑 -> 手机） --------------------------------------------
      case 'POST /api/push': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const body = await readJsonBody<{
          filePaths?: unknown;
          name?: unknown;
          note?: unknown;
        }>(req, 256 * 1024);
        if (!body || !Array.isArray(body.filePaths) || body.filePaths.length === 0) {
          return badRequest(res, 'bad_json', '需要 filePaths 数组');
        }
        const filePaths = body.filePaths.filter((p): p is string => typeof p === 'string');
        if (filePaths.length === 0) return badRequest(res, 'bad_json', 'filePaths 为空');

        const record = await ctx.engine.createPush({
          filePaths,
          name: typeof body.name === 'string' && body.name ? body.name : '来自电脑的文件',
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
        });
        emitTransfer(ctx, record);
        ctx.bus.emit('push.created', { id: record.id, name: record.name, fileCount: record.fileNames.length });
        safeJson(res, 201, { ok: true, transfer: summarize(record) });
        return { handled: true };
      }

      // --- 文本互传 ---------------------------------------------------------
      case 'POST /api/clipboard': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const body = await readJsonBody<{ text?: unknown; direction?: unknown }>(req, MAX_INLINE_TEXT + 8192);
        if (!body || typeof body.text !== 'string') {
          return badRequest(res, 'bad_json', '需要 text 字段');
        }
        const text = body.text;
        if (text.length > MAX_INLINE_TEXT) {
          return badRequest(
            res,
            'text_too_long',
            `文本超过 ${MAX_INLINE_TEXT} 字符，请改用文件传输`,
          );
        }

        const direction = body.direction === 'to-phone' ? 'to-phone' : 'to-pc';
        let writtenToSystem = false;
        if (direction === 'to-pc' && ctx.config.syncClipboard) {
          const written = await writeClipboardText(text);
          writtenToSystem = written.ok;
          if (!written.ok) {
            // 写不进剪贴板不影响功能：文本已保存，网页里可以查看与复制。
            ctx.log(
              `未能写入系统剪贴板（${written.reason ?? '未知原因'}）——文本仍已保存，可在网页里查看和复制。`,
            );
          } else if (written.degraded) {
            ctx.log(`剪贴板已写入，但走了降级路径：${written.reason ?? '可能有字符变形'}`);
          }
        }

        const entry: ClipboardEntry = {
          id: newId('clip'),
          direction,
          text,
          createdAt: Date.now(),
          writtenToSystem,
        };
        await ctx.store.addClipboard(entry);
        ctx.bus.emit('clipboard.created', { entry: publicClipboard(entry) });
        safeJson(res, 201, { ok: true, entry: publicClipboard(entry) });
        return { handled: true };
      }

      case 'GET /api/clipboard': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const entries = ctx.store.listClipboard(Number.isFinite(limit) ? Math.min(200, Math.max(1, limit)) : 20);
        safeJson(res, 200, { ok: true, entries: entries.map(publicClipboard) });
        return { handled: true };
      }

      // --- 电脑主动拉取剪贴板并推给手机 -------------------------------------
      case 'POST /api/clipboard/publish': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const body = await readJsonBody<{ text?: unknown; note?: unknown }>(req, MAX_INLINE_TEXT + 8192);
        const text = typeof body?.text === 'string' ? body.text : '';
        if (!text) return badRequest(res, 'bad_json', '需要非空 text');

        const entry: ClipboardEntry = {
          id: newId('clip'),
          direction: 'to-phone',
          text,
          createdAt: Date.now(),
        };
        await ctx.store.addClipboard(entry);
        ctx.bus.emit('clipboard.created', { entry: publicClipboard(entry) });
        safeJson(res, 201, { ok: true, entry: publicClipboard(entry) });
        return { handled: true };
      }

      case 'GET /api/clipboard/pull': {
        if (!requireAuth(req, res, ctx)) return { handled: true };
        const result = await readClipboardText();
        safeJson(res, 200, {
          ok: true,
          text: result.text,
          blocked: result.blocked ?? false,
          error: result.ok ? null : (result.reason ?? '读取失败'),
        });
        return { handled: true };
      }

      // --- 本地控制 ---------------------------------------------------------
      case 'GET /api/local/info': {
        if (!isLoopback(req)) return forbidden(res, '仅允许本机调用');
        const provided = req.headers['x-drop-token'];
        if (!ctx.controlToken || typeof provided !== 'string' || !timingSafeEqual(provided, ctx.controlToken)) {
          return forbidden(res, '控制令牌不正确');
        }
        safeJson(res, 200, {
          ok: true,
          url: ctx.runtime.advertisedUrl,
          hostName: ctx.runtime.hostName,
          recvDir: ctx.config.recvDir,
          connectedDevices: ctx.bus.subscriberCount,
          pairing: ctx.pairing.status(),
        });
        return { handled: true };
      }

      case 'POST /api/system/refresh-pairing': {
        if (!isLoopback(req)) return forbidden(res, '仅允许本机调用');
        const state = ctx.pairing.open();
        ctx.bus.emit('pair.opened', { expiresAt: state.expiresAt });
        safeJson(res, 200, { ok: true, pin: state.pin, token: state.oneTimeToken, expiresAt: state.expiresAt });
        return { handled: true };
      }

      case 'POST /api/system/shutdown': {
        if (!isLoopback(req)) return forbidden(res, '仅允许本机调用');
        safeJson(res, 200, { ok: true });
        setTimeout(() => ctx.shutdown(), 50).unref?.();
        return { handled: true };
      }

      default:
        break;
    }

    // --- 带路径参数的路由 ---------------------------------------------------
    const chunkMatch = /^\/api\/transfers\/([^/]+)\/chunks\/(\d+)$/.exec(pathname);
    if (chunkMatch) {
      if (!requireAuth(req, res, ctx)) return { handled: true };
      const transferId = chunkMatch[1]!;
      const chunkIndex = Number(chunkMatch[2]);

      if (method === 'PUT') return await putChunk(req, res, ctx, transferId, chunkIndex, url);
      if (method === 'GET') return await getChunk(req, res, ctx, transferId, chunkIndex, url);
    }

    const completeMatch = /^\/api\/transfers\/([^/]+)\/complete$/.exec(pathname);
    if (completeMatch && method === 'POST') {
      if (!requireAuth(req, res, ctx)) return { handled: true };
      const result = await ctx.engine.completeTransfer(completeMatch[1]!);
      emitTransfer(ctx, result.transfer);
      ctx.bus.emit('transfer.completed', {
        id: result.transfer.id,
        name: result.transfer.name,
        files: result.stored.map((s) => s.relPath),
        bytes: result.transfer.totalBytes,
      });
      ctx.log(
        `已接收：${result.transfer.name}（${result.stored.length} 个文件，${formatBytes(result.transfer.totalBytes)}）`,
      );
      safeJson(res, 200, {
        ok: true,
        transfer: summarize(result.transfer),
        stored: result.stored.map((s) => ({ relPath: s.relPath, bytes: s.bytes })),
      });
      return { handled: true };
    }

    const cancelMatch = /^\/api\/transfers\/([^/]+)$/.exec(pathname);
    if (cancelMatch) {
      if (!requireAuth(req, res, ctx)) return { handled: true };
      const id = cancelMatch[1]!;

      if (method === 'GET') {
        const record = ctx.store.getTransfer(id);
        if (!record) return notFound(res, '任务不存在');
        const received = ctx.engine.receivedMap(id);
        safeJson(res, 200, {
          ok: true,
          transfer: summarize(record),
          received: received?.parts ?? [],
          emptyDirs: ctx.store.getEmptyDirs(id).map((d) => d.relPath),
        });
        return { handled: true };
      }

      if (method === 'DELETE') {
        await ctx.engine.abortTransfer(id, '客户端取消');
        const record = ctx.store.getTransfer(id);
        if (record) emitTransfer(ctx, record);
        safeJson(res, 200, { ok: true });
        return { handled: true };
      }
    }

    const wholeMatch = /^\/api\/push\/([^/]+)\/files\/(\d+)\/content$/.exec(pathname);
    if (wholeMatch && method === 'GET') {
      if (!requireAuth(req, res, ctx)) return { handled: true };
      return await streamWholeFile(req, res, ctx, wholeMatch[1]!, Number(wholeMatch[2]));
    }

    const confirmMatch = /^\/api\/push\/([^/]+)\/chunks\/(\d+)\/confirm$/.exec(pathname);
    if (confirmMatch && method === 'POST') {
      if (!requireAuth(req, res, ctx)) return { handled: true };
      return await confirmPushChunk(req, res, ctx, confirmMatch[1]!, Number(confirmMatch[2]), url);
    }

    return notFound(res, `未知接口：${method} ${pathname}`);
  } catch (error) {
    return handleError(res, ctx, error);
  }
}

// --- 具体处理器 -------------------------------------------------------------

async function createUpload(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<RouteResult> {
  const body = await readJsonBody<{
    origin?: unknown;
    folderName?: unknown;
    files?: unknown;
    emptyDirs?: unknown;
    name?: unknown;
  }>(req, MAX_JSON_BODY);

  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    return badRequest(res, 'bad_json', '清单为空或格式不正确');
  }

  const files = body.files.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      relPath: String(item.relPath ?? item.name ?? ''),
      size: Number(item.size ?? 0),
      ...(typeof item.sha256 === 'string' && item.sha256 ? { sha256: item.sha256 } : {}),
      ...(typeof item.chunkSize === 'number' ? { chunkSize: item.chunkSize } : {}),
    };
  });

  const origin = body.origin === 'folder' ? 'folder' : body.origin === 'files' ? 'files' : 'file';
  const name =
    typeof body.folderName === 'string' && body.folderName
      ? body.folderName
      : typeof body.name === 'string' && body.name
        ? body.name
        : files[0]?.relPath ?? 'batch';

  const disk = await diskSpace(ctx.config.recvDir);
  const needed = files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);
  if (disk.free > 0 && needed > disk.free) {
    return safeJson(res, 507, {
      ok: false,
      code: 'insufficient_space',
      error: `磁盘空间不足：需要 ${formatBytes(needed)}，可用 ${formatBytes(disk.free)}`,
    });
  }

  const record = await ctx.engine.createUpload({
    origin,
    name,
    files,
    emptyDirs: Array.isArray(body.emptyDirs)
      ? body.emptyDirs.filter((d): d is string => typeof d === 'string')
      : [],
    ...(clientAddress(req) ? { from: clientAddress(req) } : {}),
  });

  emitTransfer(ctx, record);
  ctx.bus.emit('upload.created', {
    id: record.id,
    name: record.name,
    fileCount: record.parts.length,
    bytes: record.totalBytes,
  });

  safeJson(res, 201, {
    ok: true,
    transferId: record.id,
    name: record.name,
    chunkSize: ctx.config.chunkSize,
    maxConcurrentChunks: ctx.config.maxConcurrentChunks,
    files: record.parts.map((part, index) => ({
      index,
      relPath: part.relPath,
      size: part.size,
      chunkSize: part.chunkSize,
      chunkCount: part.chunkCount,
      received: part.receivedChunks,
    })),
  });
  return { handled: true };
}

async function putChunk(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  transferId: string,
  chunkIndex: number,
  url: URL,
): Promise<RouteResult> {
  const partIndex = Number(url.searchParams.get('part') ?? '0');
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    return badRequest(res, 'bad_part', 'part 参数不合法');
  }

  const body = await readBody(req, MAX_CHUNK_BODY);
  if (!body.ok) return badRequest(res, body.code, body.error);

  const result = await ctx.engine.receiveChunk(transferId, partIndex, chunkIndex, body.buffer);
  emitProgress(ctx, result.transfer, partIndex);

  safeJson(res, 200, {
    ok: true,
    duplicate: result.duplicate,
    chunksDone: result.transfer.chunksDone,
    chunkCount: result.transfer.chunkCount,
    doneBytes: result.transfer.doneBytes,
    totalBytes: result.transfer.totalBytes,
  });
  return { handled: true };
}

async function getChunk(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  transferId: string,
  chunkIndex: number,
  url: URL,
): Promise<RouteResult> {
  const fileIndex = Number(url.searchParams.get('file') ?? '0');
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return badRequest(res, 'bad_part', 'file 参数不合法');
  }

  const { buffer, absolute, totalSize } = await ctx.engine.readPushChunk(transferId, fileIndex, chunkIndex);
  void absolute;
  const record = ctx.store.getPush(transferId);
  const fileName = record?.fileNames[fileIndex] ?? 'file';

  // 只读不算收到：等客户端确认保存成功后才更新进度。
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buffer.length),
    'Content-Disposition': contentDisposition(fileName),
    'X-File-Size': String(totalSize),
    'X-Chunk-Index': String(chunkIndex),
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
  return { handled: true };
}

/** 客户端确认某个推送分片已保存到手机。 */
async function confirmPushChunk(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  transferId: string,
  chunkIndex: number,
  url: URL,
): Promise<RouteResult> {
  const fileIndex = Number(url.searchParams.get('file') ?? '0');
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return badRequest(res, 'bad_part', 'file 参数不合法');
  }
  const body = await readJsonBody<{ bytes?: unknown }>(req, 64 * 1024);
  const bytes = Number(body?.bytes ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return badRequest(res, 'bad_json', 'bytes 不合法');

  const updated = await ctx.engine.confirmPushChunk(transferId, fileIndex, chunkIndex, bytes);
  if (updated) emitProgress(ctx, updated);

  // 全部分片确认完毕就收尾。
  let finished = updated;
  if (updated && updated.doneBytes >= updated.totalBytes && updated.status === 'active') {
    finished = (await ctx.engine.finishPush(transferId)) ?? updated;
    ctx.bus.emit('push.completed', { id: finished.id, name: finished.name, bytes: finished.totalBytes });
    ctx.log(`手机已收完：${finished.name}（${formatBytes(finished.totalBytes)}）`);
  }
  if (finished) emitTransfer(ctx, finished);

  safeJson(res, 200, {
    ok: true,
    doneBytes: finished?.doneBytes ?? 0,
    totalBytes: finished?.totalBytes ?? 0,
    status: finished?.status ?? 'active',
  });
  return { handled: true };
}

/** 整文件下载，支持 Range（浏览器下载器与断点续传依赖它）。 */
async function streamWholeFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  transferId: string,
  fileIndex: number,
): Promise<RouteResult> {
  const record = ctx.store.getPush(transferId);
  if (!record) return notFound(res, '任务不存在');
  const filePath = record.filePaths[fileIndex];
  const size = record.fileSizes[fileIndex];
  if (filePath === undefined || size === undefined) return notFound(res, '文件不存在');

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return notFound(res, '源文件已不存在');
  }

  const fileName = record.fileNames[fileIndex] ?? 'file';
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, stat.size);
    if (!parsed) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return { handled: true };
    }
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(parsed.end - parsed.start + 1),
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': contentDisposition(fileName),
      'Cache-Control': 'no-store',
    });
    ctx.engine.openPushStream(filePath, parsed.start, parsed.end).pipe(res);
    return { handled: true };
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(fileName),
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return { handled: true };
  }
  ctx.engine.openPushStream(filePath).pipe(res);
  return { handled: true };
}

// --- 鉴权 -------------------------------------------------------------------

function authenticate(req: IncomingMessage, ctx: RouteContext) {
  const token = cookieToken(req);
  if (!token) return undefined;
  const session = ctx.store.getSession(token);
  if (!session) return undefined;
  return session;
}

/**
 * 统一鉴权：**会话 Cookie** 或 **本机 CLI 控制令牌**。
 *
 * 控制令牌只在 runtime.json 里、且只对 127.0.0.1 生效，手机拿不到，
 * 因此不会扩大攻击面；这样 `drop list` / `drop send` / `drop clip`
 * 就不必伪造会话。
 */
function authorize(req: IncomingMessage, ctx: RouteContext): boolean {
  if (authenticate(req, ctx)) return true;
  if (!isLoopback(req)) return false;
  const provided = req.headers['x-drop-token'];
  if (!ctx.controlToken || typeof provided !== 'string') return false;
  return timingSafeEqual(provided, ctx.controlToken);
}

function requireAuth(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (authorize(req, ctx)) return true;
  unauthorized(res);
  return false;
}

function cookieToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE);
}

function unauthorized(res: ServerResponse): RouteResult {
  safeJson(res, 401, { ok: false, code: 'unauthorized', error: '需要先配对：请在手机上输入电脑显示的数字 PIN' });
  return { handled: true };
}

function forbidden(res: ServerResponse, message: string): RouteResult {
  safeJson(res, 403, { ok: false, code: 'forbidden', error: message });
  return { handled: true };
}

/** 只允许来自本机的请求（用于关停、刷新配对等控制类接口）。 */
function isLoopback(req: IncomingMessage): boolean {
  const address = clientAddress(req);
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function clientAddress(req: IncomingMessage): string | undefined {
  const socket = req.socket;
  const address = socket.remoteAddress;
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

// --- 事件广播 ---------------------------------------------------------------

function emitTransfer(ctx: RouteContext, record: TransferRecord | undefined): void {
  if (!record) return;
  ctx.bus.emit('transfer.updated', { transfer: summarize(record) });
}

function emitProgress(ctx: RouteContext, record: TransferRecord, partIndex?: number): void {
  const now = Date.now();
  const last = lastProgressEmit.get(record.id) ?? 0;
  const finished = record.doneBytes >= record.totalBytes;
  if (!finished && now - last < PROGRESS_INTERVAL_MS) return;
  lastProgressEmit.set(record.id, now);

  ctx.bus.emit('progress', {
    id: record.id,
    kind: record.kind,
    name: record.name,
    doneBytes: record.doneBytes,
    totalBytes: record.totalBytes,
    chunksDone: record.chunksDone,
    chunkCount: record.chunkCount,
    partIndex: partIndex ?? null,
  });
}

function summarize(record: TransferRecord) {
  const base = {
    id: record.id,
    kind: record.kind,
    status: record.status,
    name: record.name,
    totalBytes: record.totalBytes,
    doneBytes: record.doneBytes,
    chunksDone: record.chunksDone,
    chunkCount: record.chunkCount,
    /**
     * 必须下发：手机端要靠它把分片拼回原文件。
     * 漏掉的话下载侧算出的分片数会是 NaN，整个下载路径失效。
     */
    chunkSize: record.chunkSize,
    receivedChunks: record.kind === 'push' ? record.receivedChunks.length : undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    error: record.error ?? null,
  };

  if (record.kind === 'upload') {
    return {
      ...base,
      origin: record.origin,
      fileCount: record.parts.length,
      files: record.parts.map((part) => ({
        name: part.name,
        relPath: part.storedName ?? part.relPath,
        size: part.size,
        receivedBytes: part.receivedBytes,
        chunkSize: part.chunkSize,
        chunkCount: part.chunkCount,
        receivedChunks: part.receivedChunks.length,
        done: Boolean(part.doneAt),
        sha256: part.sha256 ?? null,
      })),
    };
  }

  return {
    ...base,
    fileCount: record.filePaths.length,
    files: record.fileNames.map((name, index) => ({
      index,
      name,
      size: record.fileSizes[index] ?? 0,
      url: `/api/push/${record.id}/files/${index}/content`,
    })),
  };
}

function publicClipboard(entry: ClipboardEntry) {
  return {
    id: entry.id,
    direction: entry.direction,
    text: entry.text,
    createdAt: entry.createdAt,
    writtenToSystem: entry.writtenToSystem ?? false,
  };
}

// --- 请求/响应工具 ----------------------------------------------------------

type BodyResult = { ok: true; buffer: Buffer } | { ok: false; code: string; error: string };

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const done = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        done({ ok: false, code: 'body_too_large', error: `请求体超过 ${formatBytes(limit)}` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on('error', (error) => done({ ok: false, code: 'body_error', error: error.message }));
    req.on('aborted', () => done({ ok: false, code: 'aborted', error: '连接中断' }));
  });
}

async function readJsonBody<T>(req: IncomingMessage, limit: number): Promise<T | undefined> {
  const body = await readBody(req, limit);
  if (!body.ok) return undefined;
  if (body.buffer.length === 0) return undefined;
  try {
    return JSON.parse(body.buffer.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function safeJson(res: ServerResponse, status: number, payload: unknown): RouteResult {
  if (res.headersSent) return { handled: true };
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
  return { handled: true };
}

function badRequest(res: ServerResponse, code: string, message: string): RouteResult {
  return safeJson(res, 400, { ok: false, code, error: message });
}

function notFound(res: ServerResponse, message: string): RouteResult {
  return safeJson(res, 404, { ok: false, code: 'not_found', error: message });
}

function handleError(res: ServerResponse, ctx: RouteContext, error: unknown): RouteResult {
  if (error instanceof TransferError) {
    const payload: Record<string, unknown> = { ok: false, code: error.code, error: error.message };
    // 分片没收齐时把缺失信息带上，手机端可以直接续传。
    if (error.code === 'incomplete') payload.retryable = true;
    return safeJson(res, error.status, payload);
  }
  if (error instanceof UnsafePathError) {
    ctx.log(`拒绝不安全的路径：${error.message}`);
    return safeJson(res, 403, { ok: false, code: 'unsafe_path', error: '路径被拒绝' });
  }

  const message = error instanceof Error ? error.message : String(error);
  ctx.log(`服务器错误：${message}`);
  return safeJson(res, 500, { ok: false, code: 'internal', error: message });
}

const PAIR_MESSAGES: Record<string, string> = {
  no_window: '电脑上的配对窗口已关闭，请在电脑上重新生成二维码',
  expired: '二维码已过期，请在电脑上重新生成',
  bad_pin: 'PIN 不正确',
  bad_token: '二维码链接无效，请重新扫码',
  too_many_attempts: '错误次数过多，请在电脑上重新生成二维码',
};

// --- 杂项工具 ---------------------------------------------------------------

function parseLastEventId(req: IncomingMessage): number | undefined {
  const raw = req.headers['last-event-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRange(header: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') return undefined;

  if (rawStart === '') {
    // 后缀范围：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start > end || start >= size) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 生成兼容各浏览器的 Content-Disposition。
 * 中文文件名必须走 RFC 5987 的 `filename*`，否则下载下来会变乱码或丢失。
 */
function contentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 查询目录所在卷的容量。
 *
 * 目录还不存在时（全新环境、用户改了 --dir）先创建再查——
 * 否则会返回 0，界面和自检里就会显示"可用空间 0 B"，
 * 让人误以为磁盘满了。
 */
export async function diskSpace(dir: string): Promise<{ total: number; free: number }> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // 建不出来（权限等）也继续尝试查询，失败时返回 0 由调用方决定如何处理。
  }
  try {
    const { statfs } = await import('node:fs/promises');
    const fsStat = await statfs(dir);
    return { total: fsStat.blocks * fsStat.bsize, free: fsStat.bavail * fsStat.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function hostName(): string {
  return os.hostname() || 'PC';
}
