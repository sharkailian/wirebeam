/**
 * 文件系统安全层。
 *
 * 这个模块是"手机可以把文件写到电脑上"这一能力的唯一守门人，
 * 所有来自远端（不可信）的路径都必须先经过这里。
 *
 * 防御目标：
 *  1. 路径穿越：`..`、`../`、`..\`、绝对路径、UNC 路径、盘符
 *  2. Windows 保留设备名：CON / NUL / COM1 ...（带或不带扩展名）
 *  3. 非法字符与控制字符：< > : " | ? * \0 及 0x00-0x1F
 *  4. 尾部点与空格（Windows 上会被静默吃掉，导致路径与预期不符）
 *  5. 超长路径（Windows MAX_PATH 260）
 *  6. 编码欺骗：包含 `%2e%2e`、全角点、Unicode 归一化差异
 */

import path from 'node:path';

/** Windows 保留设备名（不区分大小写，即使带扩展名也保留）。 */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Windows 下文件名中非法的 ASCII 字符。 */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001F]/g;

/** 单段路径的长度上限，超过就截断（保留扩展名）。 */
const MAX_SEGMENT_LENGTH = 120;

/** 完整的 Windows 路径上限（含盘符与分隔符）。 */
const MAX_FULL_PATH = 250;

export interface SafePathResult {
  /** 绝对路径，保证位于 root 之内。 */
  absolute: string;
  /** 清洗后的相对路径，使用 POSIX 分隔符，用于展示与日志。 */
  relative: string;
}

/**
 * 用 `..` 逃逸出根目录时抛出。
 * 调用方应当把它转成 HTTP 403，而不是 500。
 */
export class UnsafePathError extends Error {
  readonly segment: string;

  constructor(message: string, segment = '') {
    super(message);
    this.name = 'UnsafePathError';
    this.segment = segment;
  }
}

/**
 * 清洗单个文件名（不含任何分隔符）。
 *
 * 传入的内容里若出现分隔符会被替换成下划线——注意这与
 * `sanitizeRelativePath` 的行为不同，后者把分隔符视为层级。
 */
export function sanitizeSegment(raw: string): string {
  let name = normalizeText(String(raw ?? ''));

  // 任何分隔符与冒号都不能出现在单段里；盘符（C:）也因此被消灭。
  name = name.replace(/[/\\:]/g, '_');
  name = name.replace(ILLEGAL_CHARS, '_');

  // 尾部点与空格在 Windows 上会被静默剥离，显式去掉以免路径对不上。
  name = name.replace(/[. ]+$/u, '');

  // 前导点：允许 `.gitignore` 这类文件，但不允许 `.` / `..`
  if (name === '.' || name === '..') name = '_';

  if (name.length === 0) name = 'unnamed';

  // 保留设备名：CON -> CON_，但 CONSOLE 保持原样。
  const base = name.split('.')[0] ?? '';
  if (RESERVED_NAMES.has(base.toUpperCase())) {
    name = `${base}_${name.slice(base.length)}`;
  }

  if (name.length > MAX_SEGMENT_LENGTH) {
    name = truncateKeepingExtension(name, MAX_SEGMENT_LENGTH);
  }

  return name;
}

/**
 * 把远端传来的相对路径（可能含目录层级）清洗为一个安全的相对路径。
 *
 * - 接受 `/` 与 `\` 两种分隔符（手机端可能来自不同实现）
 * - 丢弃空段与 `.`，遇到 `..` 直接抛错（而不是静默丢弃，这样调用方能发现问题）
 * - 每一段单独走 `sanitizeSegment`
 * - 返回始终使用 `/`，便于跨平台比较与写日志
 */
export function sanitizeRelativePath(raw: string): string {
  const input = normalizeText(String(raw ?? ''));

  // 绝对路径与 UNC 路径一律视为恶意/错误输入。
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw new UnsafePathError('拒绝 UNC 路径', input);
  }
  if (/^[a-zA-Z]:/.test(input)) {
    throw new UnsafePathError('拒绝带盘符的绝对路径', input);
  }
  if (input.startsWith('/') || input.startsWith('\\')) {
    throw new UnsafePathError('拒绝绝对路径', input);
  }

  const parts: string[] = [];
  for (const segment of input.split(/[/\\]+/)) {
    if (segment.length === 0) continue;
    if (segment === '.') continue;
    if (segment === '..') throw new UnsafePathError('拒绝上级目录引用', segment);
    parts.push(sanitizeSegment(segment));
  }

  if (parts.length === 0) throw new UnsafePathError('相对路径为空', input);

  const relative = parts.join('/');
  assertNotTooLong(relative);
  return relative;
}

/**
 * 把不可信的相对路径解析为 root 内的绝对路径。
 *
 * 清洗之后再做一次"真实包含"校验：即使 sanitize 有漏洞，
 * `path.relative` 的结果只要以 `..` 开头就拒绝。
 */
export function resolveWithin(root: string, relativePath: string): SafePathResult {
  const relative = sanitizeRelativePath(relativePath);
  const rootAbs = path.resolve(root);
  const absolute = path.resolve(rootAbs, relative.split('/').join(path.sep));

  const rel = path.relative(rootAbs, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafePathError('解析后的路径逃逸出根目录', relativePath);
  }
  if (rel.split(path.sep).some((s) => s === '..')) {
    throw new UnsafePathError('解析后的路径包含上级引用', relativePath);
  }
  assertNotTooLong(absolute);

  return { absolute, relative };
}

/**
 * 为已存在的路径挑选一个不冲突的名字：`a.txt` -> `a (1).txt` -> `a (2).txt`
 *
 * @param taken 判断某路径是否已被占用的函数（通常是异步的 fs.access 包装）
 */
export async function uniqueName(
  dir: string,
  fileName: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const first = path.join(dir, fileName);
  if (!(await taken(first))) return fileName;

  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await taken(path.join(dir, candidate)))) return candidate;
  }
  const fallback = `${stem}-${Date.now()}${ext}`;
  return fallback;
}

/**
 * 生成适合放进 URL / 头部 / 日志的稳定标识。
 * 只保留 ASCII，避免任何编码层面的歧义。
 */
export function safeTransferId(id: string): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

// --- 内部工具 ---------------------------------------------------------------

/**
 * Unicode 归一化 + 去掉危险字符。
 * NFKC 会把全角 `．．`、`Ｃ：` 之类折叠成 ASCII，从而让后续检查生效。
 */
function normalizeText(value: string): string {
  let text = value.normalize('NFKC');
  // 零宽字符常被用来绕过字符串匹配。
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return text.trim();
}

function truncateKeepingExtension(name: string, limit: number): string {
  const ext = path.extname(name);
  const keepExt = ext.length > 0 && ext.length <= 16 ? ext : '';
  const stem = name.slice(0, name.length - keepExt.length);
  const room = Math.max(1, limit - keepExt.length);
  return `${stem.slice(0, room)}${keepExt}`;
}

function assertNotTooLong(target: string): void {
  if (target.length > MAX_FULL_PATH) {
    throw new UnsafePathError(`路径过长（${target.length} > ${MAX_FULL_PATH}）`, target);
  }
}
