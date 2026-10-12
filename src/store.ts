/**
 * 持久化状态层。
 *
 * 设计目标：**任何时刻断电，已收到的分片都不丢**。
 *
 * 做法：
 *  - 每个变更先追加一行 JSON 到 `journal.jsonl`（追加是原子性最好的操作）
 *  - 内存中的 Map 是权威视图；`transfers.json` 只是定期写出的快照，用于启动加速
 *  - 启动时先读快照再重放日志，因此日志比快照新也不会丢数据
 *  - 日志超过阈值就压实（重写快照 + 清空日志）
 *
 * 只有服务端进程会写状态；CLI 的只读命令（list/send/clip）走 `readStateSnapshot`。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { safeTransferId, uniqueName } from './lib/fs-safety.ts';

export type TransferKind = 'upload' | 'push';
export type TransferStatus = 'active' | 'done' | 'failed' | 'cancelled';

export interface TransferBase {
  id: string;
  kind: TransferKind;
  status: TransferStatus;
  /** 展示用的名字；文件夹批次下是文件夹名。 */
  name: string;
  /** 这一批总共多少字节。 */
  totalBytes: number;
  /** 已成功落盘/已成功送达的字节数。 */
  doneBytes: number;
  /** 每个文件的字节大小，按文件顺序。 */
  fileSizes: number[];
  /** 已完成的分片数（两类任务都以此计进度）。 */
  chunksDone: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface UploadPart {
  /** 展示名（manifest 里的 relPath 最后一段，或直接给的名字）。 */
  name: string;
  /** 清洗后的相对路径，POSIX 分隔符。 */
  relPath: string;
  size: number;
  /** 服务端计算出的实际字节数，用于完成时校验。 */
  receivedBytes: number;
  /** 已收到的分片下标。 */
  receivedChunks: number[];
  /**
   * 该文件的分片大小与分片数。
   * 必须持久化：断点续传要跨服务器重启，重启后不能再依赖内存里的计划。
   */
  chunkSize: number;
  chunkCount: number;
  /** 整文件哈希（若客户端提供）。 */
  sha256?: string;
  /** 落盘后的最终文件名（含去重后缀）。 */
  storedName?: string;
  /** 完成时间。 */
  doneAt?: number;
  error?: string;
}

export interface UploadTransfer extends TransferBase {
  kind: 'upload';
  parts: UploadPart[];
  /** 客户端声明的批次类型：单文件、多文件或文件夹。 */
  origin: 'file' | 'files' | 'folder';
  /**
   * 批次目录名（清洗后）。
   *
   * `file` 模式下为空，文件直接落在 recvDir；其他模式下一律落在
   * `<recvDir>/<batchName>/` 内。必须持久化：完成某个文件时要用它拼路径，
   * 而这一步可能发生在服务器重启之后。
   */
  batchName?: string;
  /** 客户端 IP，仅用于展示。 */
  from?: string;
}

/** 空目录在传输时需要占位，否则解不出层级。 */
export interface EmptyDirEntry {
  relPath: string;
}

export interface ReceivedChunk {
  index: number;
  bytes: number;
  at: number;
}

export interface PushTransfer extends TransferBase {
  kind: 'push';
  /** 每个文件在电脑上的绝对路径（仅服务端可见）。 */
  filePaths: string[];
  /** 文件名（会展示给手机）。 */
  fileNames: string[];
  /** 客户端已确认收到的分片。 */
  receivedChunks: ReceivedChunk[];
  /** 给手机端的一句说明，例如由 `drop send` 推送。 */
  note?: string;
}

export type TransferRecord = UploadTransfer | PushTransfer;

export interface SessionRecord {
  token: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent?: string;
  remoteAddress?: string;
  label?: string;
}

export interface ClipboardEntry {
  id: string;
  direction: 'to-pc' | 'to-phone';
  text: string;
  createdAt: number;
  /** 是否成功写入了本机剪贴板。 */
  writtenToSystem?: boolean;
}

export interface StateSnapshotFile {
  version: 1;
  savedAt: number;
  transfers: TransferRecord[];
  sessions: SessionRecord[];
  clipboard: ClipboardEntry[];
  emptyDirs: Record<string, EmptyDirEntry[]>;
}

export interface StatePaths {
  root: string;
  stateDir: string;
  transfersFile: string;
  journalFile: string;
  sessionsFile: string;
  clipboardFile: string;
  chunksDir: string;
  lockFile: string;
}

export function statePaths(stateDir: string): StatePaths {
  return {
    root: stateDir,
    stateDir,
    transfersFile: path.join(stateDir, 'transfers.json'),
    journalFile: path.join(stateDir, 'journal.jsonl'),
    sessionsFile: path.join(stateDir, 'sessions.json'),
    clipboardFile: path.join(stateDir, 'clipboard.jsonl'),
    chunksDir: path.join(stateDir, 'chunks'),
    lockFile: path.join(stateDir, 'server.lock'),
  };
}

type JournalEvent =
  | { t: 'transfer.add'; record: TransferRecord }
  | { t: 'transfer.updated'; id: string; patch: Partial<TransferRecord> }
  | { t: 'transfer.part'; id: string; index: number; patch: Partial<UploadPart> }
  | { t: 'transfer.chunk'; id: string; index: number; bytes: number; at: number }
  | { t: 'session.add'; record: SessionRecord }
  | { t: 'session.touch'; token: string; at: number }
  | { t: 'session.drop'; token: string }
  | { t: 'clipboard.add'; record: ClipboardEntry }
  | { t: 'emptyDirs.set'; id: string; dirs: EmptyDirEntry[] }
  | { t: 'transfer.drop'; id: string };

const JOURNAL_COMPACT_LINES = 2000;

export class StateStore {
  readonly paths: StatePaths;
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private clipboard: ClipboardEntry[] = [];
  private readonly emptyDirs = new Map<string, EmptyDirEntry[]>();
  private journalLines = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingFlush = false;
  private closed = false;

  constructor(stateDir: string) {
    this.paths = statePaths(stateDir);
  }

  // --- 生命周期 -------------------------------------------------------------

  /** 建目录、读快照、重放日志。 */
  async init(): Promise<void> {
    await fs.mkdir(this.paths.chunksDir, { recursive: true });

    const snapshot = await readJson<StateSnapshotFile>(this.paths.transfersFile);
    if (snapshot) {
      for (const record of snapshot.transfers ?? []) this.transfers.set(record.id, record);
      for (const session of snapshot.sessions ?? []) this.sessions.set(session.token, session);
      this.clipboard = snapshot.clipboard ?? [];
      for (const [id, dirs] of Object.entries(snapshot.emptyDirs ?? {})) {
        this.emptyDirs.set(id, dirs);
      }
    }

    // 兼容早期写法：没有快照文件时，会话单独存放。
    if (!snapshot) {
      const legacySessions = await readJson<SessionRecord[]>(this.paths.sessionsFile);
      for (const session of legacySessions ?? []) this.sessions.set(session.token, session);
    }

    await this.replayJournal();
  }

  /** 关停：写完快照、清掉定时器。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // --- 传输任务 -------------------------------------------------------------

  listTransfers(): TransferRecord[] {
    return [...this.transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getTransfer(id: string): TransferRecord | undefined {
    return this.transfers.get(safeTransferId(id));
  }

  getUpload(id: string): UploadTransfer | undefined {
    const record = this.getTransfer(id);
    return record && record.kind === 'upload' ? record : undefined;
  }

  getPush(id: string): PushTransfer | undefined {
    const record = this.getTransfer(id);
    return record && record.kind === 'push' ? record : undefined;
  }

  async addTransfer(record: TransferRecord): Promise<void> {
    this.transfers.set(record.id, record);
    await this.append({ t: 'transfer.add', record });
    this.scheduleFlush();
  }

  /** 就地修改任务并写日志。 */
  async patchTransfer(id: string, patch: Partial<TransferRecord>): Promise<TransferRecord | undefined> {
    const record = this.transfers.get(safeTransferId(id));
    if (!record) return undefined;
    Object.assign(record, patch, { updatedAt: Date.now() });
    await this.append({ t: 'transfer.updated', id: record.id, patch: { ...patch, updatedAt: record.updatedAt } });
    this.scheduleFlush();
    return record;
  }

  /**
   * 标记某个分片已收到。
   * 幂等：重复上报同一分片不会重复计数。
   * 返回更新后的任务，便于调用方直接推事件。
   */
  async markChunkReceived(
    id: string,
    partIndex: number,
    chunkIndex: number,
    bytes: number,
  ): Promise<UploadTransfer | undefined> {
    const record = this.getUpload(id);
    if (!record) return undefined;
    const part = record.parts[partIndex];
    if (!part) return undefined;
    if (part.receivedChunks.includes(chunkIndex)) return record;

    part.receivedChunks.push(chunkIndex);
    part.receivedChunks.sort((a, b) => a - b);
    part.receivedBytes += bytes;
    record.chunksDone += 1;
    record.doneBytes += bytes;
    record.updatedAt = Date.now();

    await this.append({ t: 'transfer.part', id: record.id, index: partIndex, patch: { receivedChunks: part.receivedChunks, receivedBytes: part.receivedBytes } });
    await this.append({ t: 'transfer.updated', id: record.id, patch: { chunksDone: record.chunksDone, doneBytes: record.doneBytes, updatedAt: record.updatedAt } });
    this.scheduleFlush();
    return record;
  }

  /** 记录手机成功下载了一个分片（推送方向）。 */
  async markPushChunk(id: string, chunkIndex: number, bytes: number): Promise<PushTransfer | undefined> {
    const record = this.getPush(id);
    if (!record) return undefined;
    if (record.receivedChunks.some((c) => c.index === chunkIndex)) return record;

    record.receivedChunks.push({ index: chunkIndex, bytes, at: Date.now() });
    record.chunksDone += 1;
    record.doneBytes += bytes;
    record.updatedAt = Date.now();

    await this.append({ t: 'transfer.chunk', id: record.id, index: chunkIndex, bytes, at: Date.now() });
    await this.append({ t: 'transfer.updated', id: record.id, patch: { chunksDone: record.chunksDone, doneBytes: record.doneBytes, updatedAt: record.updatedAt } });
    this.scheduleFlush();
    return record;
  }

  async patchPart(id: string, partIndex: number, patch: Partial<UploadPart>): Promise<UploadTransfer | undefined> {
    const record = this.getUpload(id);
    if (!record) return undefined;
    const part = record.parts[partIndex];
    if (!part) return undefined;
    Object.assign(part, patch);
    await this.append({ t: 'transfer.part', id: record.id, index: partIndex, patch });
    this.scheduleFlush();
    return record;
  }

  async setEmptyDirs(id: string, dirs: EmptyDirEntry[]): Promise<void> {
    this.emptyDirs.set(safeTransferId(id), dirs);
    await this.append({ t: 'emptyDirs.set', id: safeTransferId(id), dirs });
    this.scheduleFlush();
  }

  getEmptyDirs(id: string): EmptyDirEntry[] {
    return this.emptyDirs.get(safeTransferId(id)) ?? [];
  }

  async removeTransfer(id: string): Promise<void> {
    const key = safeTransferId(id);
    this.transfers.delete(key);
    this.emptyDirs.delete(key);
    await this.append({ t: 'transfer.drop', id: key });
    this.scheduleFlush();
  }

  /** 清理早于 cutoff 的已完成任务，返回被清理的 id。 */
  async prune(cutoff: number): Promise<string[]> {
    const removed: string[] = [];
    for (const record of [...this.transfers.values()]) {
      const finished = record.status === 'done' || record.status === 'failed' || record.status === 'cancelled';
      if (finished && record.updatedAt < cutoff) {
        this.transfers.delete(record.id);
        removed.push(record.id);
      }
    }
    if (removed.length > 0) {
      for (const id of removed) await this.append({ t: 'transfer.drop', id });
      this.scheduleFlush();
    }
    return removed;
  }

  /**
   * 启动时把上次未完成的任务标记为可续传状态。
   * 分片文件仍在磁盘上，因此不需要改数据，只需让手机看到它是 active。
   */
  resurrectActive(): TransferRecord[] {
    return [...this.transfers.values()].filter((r) => r.status === 'active');
  }

  // --- 会话 -----------------------------------------------------------------

  listSessions(now = Date.now()): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.expiresAt > now);
  }

  getSession(token: string): SessionRecord | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) return undefined;
    return session;
  }

  async addSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.token, record);
    await this.append({ t: 'session.add', record });
    this.scheduleFlush();
  }

  async touchSession(token: string, now = Date.now()): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;
    session.lastSeenAt = now;
    await this.append({ t: 'session.touch', token, at: now });
    this.scheduleFlush();
  }

  async dropSession(token: string): Promise<void> {
    this.sessions.delete(token);
    await this.append({ t: 'session.drop', token });
    this.scheduleFlush();
  }

  /** 移除过期会话，返回移除数量。 */
  async pruneSessions(now = Date.now()): Promise<number> {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= now) {
        this.sessions.delete(session.token);
        await this.append({ t: 'session.drop', token: session.token });
        count += 1;
      }
    }
    if (count > 0) this.scheduleFlush();
    return count;
  }

  // --- 剪贴板 ---------------------------------------------------------------

  listClipboard(limit = 50): ClipboardEntry[] {
    return this.clipboard.slice(-limit).reverse();
  }

  latestClipboard(): ClipboardEntry | undefined {
    return this.clipboard[this.clipboard.length - 1];
  }

  async addClipboard(entry: ClipboardEntry, maxEntries = 200): Promise<void> {
    this.clipboard.push(entry);
    if (this.clipboard.length > maxEntries) this.clipboard = this.clipboard.slice(-maxEntries);
    await this.append({ t: 'clipboard.add', record: entry });
    await fs.appendFile(this.paths.clipboardFile, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {});
    this.scheduleFlush();
  }

  // --- 落盘与日志 -----------------------------------------------------------

  private async append(event: JournalEvent): Promise<void> {
    if (this.closed) return;
    try {
      await fs.appendFile(this.paths.journalFile, `${JSON.stringify(event)}\n`, 'utf8');
      this.journalLines += 1;
      if (this.journalLines > JOURNAL_COMPACT_LINES) await this.flush();
    } catch {
      // 日志写失败不应中断传输：内存状态仍然正确。
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.pendingFlush) return;
    this.pendingFlush = true;
    this.flushTimer = setTimeout(() => {
      this.pendingFlush = false;
      this.flushTimer = null;
      void this.flush();
    }, 1500);
    this.flushTimer.unref?.();
  }

  /** 写出快照并压实日志。 */
  async flush(): Promise<void> {
    const snapshot: StateSnapshotFile = {
      version: 1,
      savedAt: Date.now(),
      transfers: [...this.transfers.values()],
      sessions: [...this.sessions.values()],
      clipboard: this.clipboard,
      emptyDirs: Object.fromEntries(this.emptyDirs),
    };
    try {
      await writeJsonAtomic(this.paths.transfersFile, snapshot);
      await fs.writeFile(this.paths.journalFile, '', 'utf8');
      this.journalLines = 0;
    } catch {
      // 忽略：下次 flush 会重试。
    }
  }

  private async replayJournal(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.journalFile, 'utf8');
    } catch {
      return;
    }
    if (raw.trim().length === 0) return;

    let lines = 0;
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      lines += 1;
      let event: JournalEvent;
      try {
        event = JSON.parse(line) as JournalEvent;
      } catch {
        continue; // 断电时可能写出半行，跳过即可。
      }
      this.applyEvent(event);
    }
    this.journalLines = lines;
  }

  private applyEvent(event: JournalEvent): void {
    switch (event.t) {
      case 'transfer.add':
        this.transfers.set(event.record.id, event.record);
        break;
      case 'transfer.updated': {
        const record = this.transfers.get(event.id);
        if (record) Object.assign(record, event.patch);
        break;
      }
      case 'transfer.part': {
        const record = this.transfers.get(event.id);
        if (record && record.kind === 'upload') {
          const part = record.parts[event.index];
          if (part) Object.assign(part, event.patch);
        }
        break;
      }
      case 'transfer.chunk': {
        const record = this.transfers.get(event.id);
        if (record && record.kind === 'push') {
          if (!record.receivedChunks.some((c) => c.index === event.index)) {
            record.receivedChunks.push({ index: event.index, bytes: event.bytes, at: event.at });
          }
        }
        break;
      }
      case 'session.add':
        this.sessions.set(event.record.token, event.record);
        break;
      case 'session.touch': {
        const session = this.sessions.get(event.token);
        if (session) session.lastSeenAt = event.at;
        break;
      }
      case 'session.drop':
        this.sessions.delete(event.token);
        break;
      case 'clipboard.add':
        this.clipboard.push(event.record);
        break;
      case 'emptyDirs.set':
        this.emptyDirs.set(event.id, event.dirs);
        break;
      case 'transfer.drop':
        this.transfers.delete(event.id);
        break;
      default:
        break;
    }
  }
}

/** 只读打开状态，供 CLI 的 list/send/clip 命令使用（不需要启动服务器）。 */
export async function readStateSnapshot(stateDir: string): Promise<StateSnapshotFile | undefined> {
  return readJson<StateSnapshotFile>(statePaths(stateDir).transfersFile);
}

export function newId(prefix: string): string {
  const bolt = crypto.randomBytes(6).toString('hex');
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}${bolt}`;
}

export async function newUniqueFileName(
  dir: string,
  desired: string,
  taken: (candidate: string) => Promise<boolean> = defaultTaken,
): Promise<string> {
  return uniqueName(dir, desired, taken);
}

async function defaultTaken(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

// --- 通用文件工具 -----------------------------------------------------------

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (raw.trim().length === 0) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** 先写临时文件再 rename，避免半个 JSON 被读到。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}
