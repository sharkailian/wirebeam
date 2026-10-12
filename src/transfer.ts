/**
 * 传输引擎。
 *
 * 两条方向：
 *  - 接收（手机 -> 电脑）：客户端逐块 PUT，服务端流式写入 `.part` 文件，
 *    每块记录到状态里；任何时刻中断都能从已收块继续。
 *  - 发送（电脑 -> 手机）：手机按 Range 拉取，服务端只负责给出正确的字节范围。
 *
 * 关键保证：
 *  - **流式**：任何一块的最大内存占用是 chunkSize，绝不整文件读入内存
 *  - **幂等**：重复上传同一块直接返回成功，不重复计数
 *  - **可校验**：客户端提供整文件 sha256 时，落盘前必须一致，否则拒绝
 *  - **原子可见**：只有全部校验通过才把 `.part` 改名为最终文件，
 *    因此 `recv/` 目录里永远不出现半截文件
 *  - **安全**：所有相对路径先过 `resolveWithin`
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { UnsafePathError, resolveWithin, sanitizeSegment } from './lib/fs-safety.ts';
import type { Config } from './config.ts';
import type { UploadPart, UploadTransfer, PushTransfer } from './store.ts';
import { StateStore, newId } from './store.ts';

/** 服务端接受的单块上限，防止恶意超大 body 撑爆内存。 */
const MAX_ACCEPTED_CHUNK = 64 * 1024 * 1024;

export interface FileRequest {
  /** 客户端提供的相对路径（可能含层级），不可信。 */
  relPath: string;
  /** 客户端声明的字节数。 */
  size: number;
  /** 客户端能提供的整文件 sha256（可选）。 */
  sha256?: string;
  /** 客户端建议的分片大小（服务端会夹在自己的上下限内）。 */
  chunkSize?: number;
}

export interface CreateUploadOptions {
  origin: 'file' | 'files' | 'folder';
  /** 单文件时作为展示名；文件夹时作为批次名。 */
  name: string;
  files: FileRequest[];
  /** 空目录列表，用于还原层级。 */
  emptyDirs?: string[];
  from?: string;
}

export interface CompleteResult {
  transfer: UploadTransfer;
  /** 每个文件的最终落盘路径。 */
  stored: { relPath: string; absolute: string; bytes: number; sha256: string }[];
}

export class TransferError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 每个文件的写入调度。
 *
 * 为什么必须有它：**同一个文件句柄上并发调用 `handle.write` 是不安全的**
 * （Node 文档明确警告 data 可能被交错写入）。浏览器上传是并发的，
 * 不同分片会同时到达同一个文件，所以必须在这里排队。
 *
 * 同时限制队列长度：一个 8 MiB 的分片排队时，如果任由队列增长，
 * 并发 8 就是 64 MiB 常驻内存。上限到了就让 `push` 等待，
 * 形成背压，内存占用有确定上界。
 */
class WriteQueue {
  private readonly tasks: (() => Promise<void>)[] = [];
  private readonly waiters: (() => void)[] = [];
  private running = false;
  private failure: Error | null = null;
  private readonly maxPending: number;
  /** 复用的文件句柄，避免每个分片都开关一次文件。 */
  private handle: import('node:fs/promises').FileHandle | null = null;
  private readonly file: string;

  constructor(file: string, maxPending: number) {
    this.file = file;
    this.maxPending = Math.max(1, maxPending);
  }

  /**
   * 取得文件句柄。
   *
   * **绝对不能用 `a+`**：append 模式下 `handle.write(buffer, offset, length, position)`
   * 的 position 会被忽略，数据变成纯追加，并发/乱序写入必然损坏文件。
   * 这里用 `r+`（读写、不截断），文件不存在时退回 `w+` 创建。
   */
  private async openHandle(): Promise<import('node:fs/promises').FileHandle> {
    if (this.handle) return this.handle;
    let handle: import('node:fs/promises').FileHandle;
    try {
      handle = await fs.open(this.file, 'r+');
    } catch {
      handle = await fs.open(this.file, 'w+');
    }
    this.handle = handle;
    return handle;
  }

  /** 落盘并关闭句柄；队列排空后调用。 */
  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    await handle.sync().catch(() => {});
    await handle.close().catch(() => {});
  }

  /** 排队一个写入。task 拿到的是已打开的句柄，按给定 position 写即可。 */
  async push(task: (handle: import('node:fs/promises').FileHandle) => Promise<void>): Promise<void> {
    if (this.failure) throw this.failure;

    // 背压：队列满时先等空位，避免几十 MB 的分片堆在内存里。
    while (this.tasks.length >= this.maxPending) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.failure) throw this.failure;
    }

    return await new Promise<void>((resolve, reject) => {
      this.tasks.push(async () => {
        try {
          await task(await this.openHandle());
          resolve();
        } catch (error) {
          this.failure = error as Error;
          reject(error);
        }
      });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.running && this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      this.running = true;
      // 每取走一个任务就唤醒一个等待空位的调用方。
      this.waiters.shift()?.();
      void task().finally(() => {
        this.running = false;
        if (this.tasks.length === 0) void this.closeHandle();
        this.pump();
      });
    }
  }

  /** 队列空且没有正在执行的任务。 */
  get idle(): boolean {
    return !this.running && this.tasks.length === 0;
  }

  /** 等所有已排队的写入落盘，并关闭句柄。 */
  async drain(): Promise<void> {
    while (!this.idle) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await this.closeHandle();
    if (this.failure) throw this.failure;
  }

  /** 丢弃队列并关闭句柄（用于中止传输，释放已缓冲的分片）。 */
  async clear(): Promise<void> {
    this.tasks.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter();
    await this.closeHandle();
  }
}

export class TransferEngine {
  private readonly config: Config;
  private readonly store: StateStore;
  private readonly queues = new Map<string, WriteQueue>();
  /** 缓存的最终落盘文件名，避免重复探测磁盘。 */
  private readonly plannedNames = new Map<string, string>();

  constructor(config: Config, store: StateStore) {
    this.config = config;
    this.store = store;
  }

  /** 确保接收目录与临时目录存在。 */
  async init(): Promise<void> {
    await fs.mkdir(this.config.recvDir, { recursive: true });
    await fs.mkdir(this.chunksDir(), { recursive: true });
  }

  // --- 接收方向 -------------------------------------------------------------

  /**
   * 批次目录的语义（对用户可见，务必保持一致）：
   *  - `file`：单文件，直接落在 `<recvDir>/` 下
   *  - `files` / `folder`：多文件或文件夹，整体落在 `<recvDir>/<批次名>/` 下，
   *    这样一次传输就是一坨，不会把 recvDir 搅成一锅粥
   */

  /** 批次目录相对于 recvDir 的前缀（`''` 表示没有批次目录）。 */
  private batchRelative(record: UploadTransfer): string {
    if (record.origin === 'file') return '';
    const name = sanitizeSegment(record.batchName || record.name || 'batch');
    return name;
  }

  /**
   * 去掉相对路径开头重复的批次名。
   *
   * 浏览器的 `webkitRelativePath` 形如 `我的照片/子目录/a.jpg`，本身就带了
   * 文件夹名；如果原样再放进以文件夹名命名的批次目录，就会多出一层
   * `recv/我的照片/我的照片/...`。这里统一剥掉开头那一层。
   */
  private stripBatchPrefix(relative: string, batchName: string): string {
    if (!batchName) return relative;
    const segments = relative.split('/');
    if (segments.length > 1 && segments[0] === batchName) {
      return segments.slice(1).join('/');
    }
    return relative;
  }

  /** 计算某个文件最终应当落到的绝对路径。 */
  private resolveTarget(record: UploadTransfer, relative: string): { absolute: string; relative: string } {
    const prefix = this.batchRelative(record);
    const inner = this.stripBatchPrefix(relative, prefix);
    const combined = prefix ? `${prefix}/${inner}` : inner;
    const resolved = resolveWithin(this.config.recvDir, combined);
    return { absolute: resolved.absolute, relative: resolved.relative };
  }

  /** 批次内的相对路径（用于展示与去重，不含批次目录名）。 */
  private innerRelative(relative: string, batchName: string): string {
    return this.stripBatchPrefix(relative, batchName);
  }

  async createUpload(options: CreateUploadOptions): Promise<UploadTransfer> {
    if (options.files.length === 0) {
      throw new TransferError(400, 'no_files', '清单里没有任何文件');
    }

    const parts: UploadPart[] = [];
    const seen = new Map<string, number>();
    const batchName = options.origin === 'file' ? '' : sanitizeSegment(options.name || 'batch');

    // 校验批次目录本身也是安全的（用户提供的文件夹名同样不可信）。
    if (batchName) resolveWithin(this.config.recvDir, batchName);

    for (const file of options.files) {
      let relative: string;
      try {
        relative = resolveWithin(this.config.recvDir, file.relPath).relative;
      } catch (error) {
        if (error instanceof UnsafePathError) {
          throw new TransferError(400, 'unsafe_path', `路径不安全：${error.message}`);
        }
        throw error;
      }

      // 统一存成"批次内的相对路径"：去掉浏览器相对路径开头重复的文件夹名。
      relative = this.innerRelative(relative, batchName);
      if (relative.length === 0) {
        throw new TransferError(400, 'unsafe_path', `路径解析后为空：${file.relPath}`);
      }

      // 同一批次里重复的相对路径只保留一份（浏览器可能重复选中同一文件）。
      const hits = seen.get(relative) ?? 0;
      seen.set(relative, hits + 1);
      if (hits > 0) continue;

      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new TransferError(400, 'bad_size', `文件大小非法：${file.relPath}`);
      }
      if (file.size > this.config.maxFileSize) {
        throw new TransferError(413, 'too_large', `文件超过上限：${file.relPath}`);
      }

      const chunkSize = clampChunkSize(file.chunkSize ?? this.config.chunkSize, this.config.chunkSize);
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));

      parts.push({
        name: path.posix.basename(relative) || sanitizeSegment(relative),
        relPath: relative,
        size: file.size,
        receivedBytes: 0,
        receivedChunks: [],
        chunkSize,
        chunkCount,
        ...(file.sha256 ? { sha256: file.sha256.toLowerCase() } : {}),
      });
    }

    if (parts.length === 0) {
      throw new TransferError(400, 'no_files', '清单去重后为空');
    }

    const totalBytes = parts.reduce((sum, part) => sum + part.size, 0);
    const now = Date.now();

    const record: UploadTransfer = {
      id: newId('up'),
      kind: 'upload',
      status: 'active',
      name: options.origin === 'file' ? (parts[0]?.name ?? 'file') : (options.name || 'batch'),
      origin: options.origin,
      parts,
      totalBytes,
      doneBytes: 0,
      fileSizes: parts.map((p) => p.size),
      chunksDone: 0,
      chunkSize: this.config.chunkSize,
      chunkCount: parts.reduce((sum, part) => sum + part.chunkCount, 0),
      createdAt: now,
      updatedAt: now,
      ...(batchName ? { batchName } : {}),
      ...(options.from ? { from: options.from } : {}),
    };

    await fs.mkdir(this.partDir(record.id), { recursive: true });
    await this.store.addTransfer(record);

    if (options.emptyDirs && options.emptyDirs.length > 0) {
      const dirs = options.emptyDirs.map((dir) => {
        const { relative } = resolveWithin(this.config.recvDir, dir);
        return { relPath: relative };
      });
      await this.store.setEmptyDirs(record.id, dirs);
    }

    return record;
  }

  /**
   * 接收一个分片。
   *
   * 幂等：已标记成功的块直接返回，不再写盘。
   * 顺序：同一文件的多次调用按到达顺序串行写，避免 offset 竞争。
   */
  async receiveChunk(
    transferId: string,
    partIndex: number,
    chunkIndex: number,
    data: Buffer,
  ): Promise<{ bytes: number; duplicate: boolean; transfer: UploadTransfer }> {
    const record = this.store.getUpload(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');
    if (record.status !== 'active') {
      throw new TransferError(409, 'not_active', `任务状态为 ${record.status}，不能继续写入`);
    }

    const part = record.parts[partIndex];
    if (!part) throw new TransferError(400, 'bad_part', `文件下标越界：${partIndex}`);
    if (data.length > MAX_ACCEPTED_CHUNK) {
      throw new TransferError(413, 'chunk_too_large', '分片超过服务端上限');
    }

    if (part.receivedChunks.includes(chunkIndex)) {
      return { bytes: data.length, duplicate: true, transfer: record };
    }

    const chunkSize = part.chunkSize || this.config.chunkSize;
    const chunkCount = chunkCountOf(part, chunkSize);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
      throw new TransferError(400, 'bad_chunk', `分片下标越界：${chunkIndex}/${chunkCount}`);
    }

    const offset = chunkIndex * chunkSize;
    const expected = Math.min(chunkSize, part.size - offset);
    if (data.length !== expected) {
      throw new TransferError(
        400,
        'chunk_size_mismatch',
        `分片长度不符：收到 ${data.length}，期望 ${expected}`,
      );
    }

    const file = this.partFile(record.id, partIndex);
    await fs.mkdir(path.dirname(file), { recursive: true });

    await this.queue(record.id, partIndex, file).push(async (handle) => {
      let written = 0;
      while (written < data.length) {
        const { bytesWritten } = await handle.write(
          data,
          written,
          data.length - written,
          offset + written,
        );
        if (bytesWritten <= 0) throw new Error('写入返回 0 字节');
        written += bytesWritten;
      }
    });

    const updated = await this.store.markChunkReceived(record.id, partIndex, chunkIndex, data.length);
    return { bytes: data.length, duplicate: false, transfer: updated ?? record };
  }

  /**
   * 结束一个文件的接收：等写队列排空，校验大小与哈希，然后原子改名到最终位置。
   */
  async completePart(transferId: string, partIndex: number): Promise<UploadPart> {
    const record = this.store.getUpload(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');
    const part = record.parts[partIndex];
    if (!part) throw new TransferError(400, 'bad_part', `文件下标越界：${partIndex}`);

    const source = this.partFile(record.id, partIndex);
    await fs.mkdir(path.dirname(source), { recursive: true });

    // 先等这个文件的所有写入落盘并关闭句柄，再去读它做校验。
    await this.queue(record.id, partIndex, source).drain();

    const chunkSize = part.chunkSize || this.config.chunkSize;
    const chunkCount = chunkCountOf(part, chunkSize);

    // 空文件没有任何分片，但用户确实选了它——显式造一个 0 字节文件。
    if (part.size === 0) {
      const stat = await fs.stat(source).catch(() => undefined);
      if (!stat) {
        await fs.writeFile(source, Buffer.alloc(0));
        if (part.receivedChunks.length === 0) {
          await this.store.markChunkReceived(record.id, partIndex, 0, 0);
        }
      }
    }

    const missing: number[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      if (!part.receivedChunks.includes(i)) missing.push(i);
    }
    if (missing.length > 0) {
      throw new TransferError(
        409,
        'incomplete',
        `还有 ${missing.length} 个分片未收到（例如 ${missing.slice(0, 5).join(',')}）`,
      );
    }

    const stat = await fs.stat(source).catch(() => undefined);
    const actualSize = stat?.size ?? 0;
    if (actualSize !== part.size) {
      throw new TransferError(
        409,
        'size_mismatch',
        `大小不符：磁盘 ${actualSize}，声明 ${part.size}`,
      );
    }

    let digest = '';
    if (part.sha256) {
      digest = await sha256File(source);
      if (digest !== part.sha256) {
        // 分片级校验通过但整体不符：可能客户端算错，也可能数据被改。
        await fs.rm(source, { force: true });
        await this.store.patchPart(record.id, partIndex, {
          receivedChunks: [],
          receivedBytes: 0,
          error: `哈希不符：期望 ${part.sha256}，实际 ${digest}`,
        });
        throw new TransferError(409, 'hash_mismatch', `文件哈希不符：${part.name}`);
      }
    } else {
      digest = await sha256File(source);
    }

    const relative = part.relPath;
    // 落盘路径 = 批次目录 + 文件在批次内的相对路径。
    const target = this.resolveTarget(record, relative);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });

    const finalName = await this.claimFinalName(record.id, partIndex, target.absolute);
    await moveFile(source, finalName);

    // storedName 是"相对 recvDir"的完整路径，用于展示与完成时的校验。
    const storedName = path.relative(this.config.recvDir, finalName).split(path.sep).join('/');
    await this.store.patchPart(record.id, partIndex, {
      storedName,
      doneAt: Date.now(),
      sha256: digest,
      error: undefined,
    });

    return this.store.getUpload(record.id)?.parts[partIndex] ?? part;
  }

  /** 结束整个批次：还原空目录、标记完成。 */
  async completeTransfer(transferId: string): Promise<CompleteResult> {
    const record = this.store.getUpload(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');

    const stored: CompleteResult['stored'] = [];
    for (let i = 0; i < record.parts.length; i += 1) {
      const part = record.parts[i]!;
      if (part.doneAt) {
        // storedName 已经相对 recvDir，直接用。
        const { absolute } = resolveWithin(this.config.recvDir, part.storedName ?? part.relPath);
        stored.push({
          relPath: part.storedName ?? part.relPath,
          absolute,
          bytes: part.receivedBytes,
          sha256: part.sha256 ?? '',
        });
        continue;
      }
      const finished = await this.completePart(record.id, i);
      const { absolute } = resolveWithin(this.config.recvDir, finished.storedName ?? finished.relPath);
      stored.push({
        relPath: finished.storedName ?? finished.relPath,
        absolute,
        bytes: finished.receivedBytes,
        sha256: finished.sha256 ?? '',
      });
    }

    // 还原空目录，否则"文件夹传输"会丢层级。空目录路径也是批次内的相对路径。
    for (const dir of this.store.getEmptyDirs(record.id)) {
      try {
        const target = this.resolveTarget(record, dir.relPath);
        await fs.mkdir(target.absolute, { recursive: true });
      } catch {
        // 单个空目录失败不应让整个批次失败。
      }
    }

    await this.cleanupParts(record.id);
    const updated = await this.store.patchTransfer(record.id, { status: 'done' });
    return { transfer: (updated as UploadTransfer) ?? record, stored };
  }

  /** 中止并清理临时分片。 */
  async abortTransfer(transferId: string, reason: string): Promise<void> {
    const record = this.store.getUpload(transferId);
    if (!record) return;
    await this.cleanupParts(record.id);
    await this.store.patchTransfer(record.id, { status: 'cancelled', error: reason });
  }

  /** 已经收到哪些块（供手机端跳过重传）。 */
  receivedMap(transferId: string): { parts: { index: number; received: number[] }[] } | undefined {
    const record = this.store.getUpload(transferId);
    if (!record) return undefined;
    return {
      parts: record.parts.map((part, index) => ({ index, received: [...part.receivedChunks] })),
    };
  }

  // --- 发送方向 -------------------------------------------------------------

  /** 创建一个推送任务（电脑 -> 手机）。 */
  async createPush(input: {
    filePaths: string[];
    name: string;
    note?: string;
    chunkSize?: number;
  }): Promise<PushTransfer> {
    const sizes: number[] = [];
    const names: string[] = [];

    for (const filePath of input.filePaths) {
      // 路径不存在/不是文件必须是 400（客户端问题），不是 500（服务器问题）。
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        throw new TransferError(400, 'file_not_found', `找不到文件：${filePath}`);
      }
      if (!stat.isFile()) throw new TransferError(400, 'not_a_file', `不是文件：${filePath}`);
      if (stat.size > this.config.maxFileSize) {
        throw new TransferError(413, 'too_large', `文件超过上限：${filePath}`);
      }
      sizes.push(stat.size);
      names.push(path.basename(filePath));
    }

    const chunkSize = clampChunkSize(input.chunkSize ?? this.config.chunkSize, this.config.chunkSize);
    const now = Date.now();
    const record: PushTransfer = {
      id: newId('push'),
      kind: 'push',
      status: 'active',
      name: input.name,
      filePaths: input.filePaths.map((p) => path.resolve(p)),
      fileNames: names,
      fileSizes: sizes,
      totalBytes: sizes.reduce((sum, n) => sum + n, 0),
      doneBytes: 0,
      chunksDone: 0,
      chunkSize,
      chunkCount: sizes.reduce((sum, size) => sum + Math.max(1, Math.ceil(size / chunkSize)), 0),
      receivedChunks: [],
      createdAt: now,
      updatedAt: now,
      ...(input.note ? { note: input.note } : {}),
    };

    await this.store.addTransfer(record);
    return record;
  }

  /** 推送任务里某个文件的分片布局。 */
  pushLayout(record: PushTransfer, fileIndex: number): { offset: number; length: number; chunkSize: number } {
    const filePath = record.filePaths[fileIndex];
    const size = record.fileSizes[fileIndex];
    if (filePath === undefined || size === undefined) {
      throw new TransferError(400, 'bad_part', `文件下标越界：${fileIndex}`);
    }
    const chunkSize = record.chunkSize;
    const startChunk = record.fileSizes
      .slice(0, fileIndex)
      .reduce((sum, s) => sum + Math.max(1, Math.ceil(s / chunkSize)), 0);
    return { offset: startChunk, length: size, chunkSize };
  }

  /**
   * 只读取分片内容，**不改变任何状态**。
   * 是否"已收到"必须由客户端显式确认（见 `confirmPushChunk`），
   * 否则浏览器取消下载也会被误判成传输成功。
   */
  async readPushChunk(
    transferId: string,
    fileIndex: number,
    chunkIndex: number,
  ): Promise<{ buffer: Buffer; absolute: string; totalSize: number; chunkCount: number }> {
    const record = this.store.getPush(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');
    const filePath = record.filePaths[fileIndex];
    const size = record.fileSizes[fileIndex];
    if (filePath === undefined || size === undefined) {
      throw new TransferError(400, 'bad_part', `文件下标越界：${fileIndex}`);
    }

    const chunkSize = record.chunkSize;
    const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
      throw new TransferError(400, 'bad_chunk', `分片下标越界：${chunkIndex}/${chunkCount}`);
    }

    const start = chunkIndex * chunkSize;
    const end = Math.min(size, start + chunkSize) - 1;
    const buffer = await readRange(filePath, start, Math.max(start, end));
    return { buffer, absolute: filePath, totalSize: size, chunkCount };
  }

  /** 客户端确认某个推送分片已成功保存。 */
  async confirmPushChunk(
    transferId: string,
    fileIndex: number,
    chunkIndex: number,
    bytes: number,
  ): Promise<PushTransfer | undefined> {
    const record = this.store.getPush(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');
    const size = record.fileSizes[fileIndex];
    if (size === undefined) throw new TransferError(400, 'bad_part', `文件下标越界：${fileIndex}`);

    const chunkSize = record.chunkSize;
    const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
      throw new TransferError(400, 'bad_chunk', `分片下标越界：${chunkIndex}/${chunkCount}`);
    }

    return this.store.markPushChunk(transferId, chunkIndex, bytes);
  }

  /** 把某个推送任务标记为完成。 */
  async finishPush(transferId: string): Promise<PushTransfer | undefined> {
    const record = this.store.getPush(transferId);
    if (!record) throw new TransferError(404, 'no_transfer', '任务不存在');
    const updated = await this.store.patchTransfer(transferId, { status: 'done' });
    return updated as PushTransfer | undefined;
  }

  /** 打开推送文件的读取流（用于整文件下载或 Range 请求）。 */
  openPushStream(filePath: string, start?: number, end?: number) {
    return createReadStream(filePath, start === undefined ? {} : { start, end });
  }

  // --- 内部工具 -------------------------------------------------------------

  private chunksDir(): string {
    return path.join(this.config.stateDir, 'chunks');
  }

  private partDir(transferId: string): string {
    return path.join(this.chunksDir(), transferId);
  }

  private partFile(transferId: string, partIndex: number): string {
    return path.join(this.partDir(transferId), `${partIndex}.part`);
  }

  private queue(transferId: string, partIndex: number, file: string): WriteQueue {
    const key = `${transferId}:${partIndex}`;
    let queue = this.queues.get(key);
    if (!queue) {
      // 上限 4：即最多 4 个分片在排队等待落盘，内存占用有确定上界。
      queue = new WriteQueue(file, 4);
      this.queues.set(key, queue);
    }
    return queue;
  }

  /** 目标已存在时，挑一个不冲突的名字（`a (1).txt`）。 */
  private async claimFinalName(
    transferId: string,
    partIndex: number,
    absolute: string,
  ): Promise<string> {
    const key = `${transferId}:${partIndex}`;
    const cached = this.plannedNames.get(key);
    if (cached) return cached;

    const dir = path.dirname(absolute);
    const base = path.basename(absolute);
    const exists = async (candidate: string): Promise<boolean> => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    };

    let chosen = path.join(dir, base);
    if (await exists(chosen)) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      for (let i = 1; i < 10_000; i += 1) {
        const candidate = path.join(dir, `${stem} (${i})${ext}`);
        if (!(await exists(candidate))) {
          chosen = candidate;
          break;
        }
      }
    }

    this.plannedNames.set(key, chosen);
    return chosen;
  }

  private async cleanupParts(transferId: string): Promise<void> {
    await fs.rm(this.partDir(transferId), { recursive: true, force: true }).catch(() => {});
    for (const key of [...this.plannedNames.keys()]) {
      if (key.startsWith(`${transferId}:`)) this.plannedNames.delete(key);
    }
  }

  /** 清理没有对应任务记录的孤儿分片目录（例如状态被 prune 掉）。 */
  async sweepOrphanParts(): Promise<number> {
    let removed = 0;
    const known = new Set(this.store.listTransfers().map((t) => t.id));
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.chunksDir());
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (known.has(entry)) continue;
      await fs.rm(path.join(this.chunksDir(), entry), { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }
}

// --- 模块级辅助 -------------------------------------------------------------

/** 分片数：持久化在 part 上；为兼容旧状态，缺失时按大小推算。 */
function chunkCountOf(part: UploadPart, chunkSize: number): number {
  if (Number.isSafeInteger(part.chunkCount) && part.chunkCount > 0) return part.chunkCount;
  return Math.max(1, Math.ceil(part.size / chunkSize));
}

function clampChunkSize(requested: number, fallback: number): number {
  const min = 64 * 1024;
  const max = MAX_ACCEPTED_CHUNK;
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(requested)));
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** 跨盘时 rename 会失败，退回 copy + unlink。 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
  }
  await fs.copyFile(from, to);
  await fs.rm(from, { force: true });
}

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(file, { start, end });
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** 供服务层写文件流用（例如把推送文件另存）。 */
export function createSink(file: string) {
  return createWriteStream(file);
}
