/**
 * 运行时配置与命令行解析。
 *
 * 配置对象在进程内只创建一次，之后作为只读数据向下传递；
 * 只有 `Config.port` 允许在监听失败后改写（端口顺延时）。
 */

import path from 'node:path';

/** 默认分片大小：8 MiB。 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/** 单段文本超过该长度时降级为 .txt 文件传输（64 KiB）。 */
export const MAX_INLINE_TEXT = 64 * 1024;

export interface Config {
  /** 监听端口，0 表示由系统分配。 */
  port: number;
  /** 监听地址。默认 0.0.0.0 以便手机访问；`127.0.0.1` 仅供本机测试。 */
  host: string;
  /** 手机传来的文件落到这里。 */
  recvDir: string;
  /** 状态目录（会话、日志、临时分片）。 */
  stateDir: string;
  /** 分片大小（字节）。 */
  chunkSize: number;
  /** 单个传输任务的并发分片上限。 */
  maxConcurrentChunks: number;
  /** 会话有效期（毫秒）。 */
  sessionTtlMs: number;
  /** 待配对窗口的有效期（毫秒），即二维码的有效时间。 */
  pairTtlMs: number;
  /** 任务完成后保留元数据的时长（毫秒）。 */
  retentionMs: number;
  /** 允许的最大单文件大小（字节）。 */
  maxFileSize: number;
  /** 是否在收到文本时同步写入本机剪贴板。 */
  syncClipboard: boolean;
  /** 终端二维码旁边展示的访问地址所用的主机覆盖值。 */
  advertisedHost?: string;
  /** 是否打印详细日志。 */
  verbose: boolean;
  /** 绑定到 127.0.0.1 时不监听局域网。 */
  loopbackOnly: boolean;
}

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'loopback', 'no-clipboard', 'verbose', 'json', 'open',
]);

/**
 * 解析形如 `drop serve --port 9000 --dir ./out` 的参数。
 * 支持 `--flag value`、`--flag=value`、`-p 9000` 与 `--no-xxx`。
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('-') && token.length > 1 && !isNegativeNumber(token)) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const key = normalizeFlag(token.slice(0, eq));
        flags.set(key, token.slice(eq + 1));
        continue;
      }

      const key = normalizeFlag(token);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, true);
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }

    positional.push(token);
  }

  const command = positional.shift() ?? 'help';
  return { command, positional, flags };
}

/**
 * 由命令行参数构造配置。
 * 未知参数不报错，交给各命令自行判断需要哪些。
 */
export function buildConfig(parsed: ParsedArgs, cwd = process.cwd()): Config {
  const flags = parsed.flags;
  const dataRoot = path.resolve(cwd, 'data');

  const recvFlag = getString(flags, 'dir') ?? getString(flags, 'out');
  const recvDir = recvFlag ? path.resolve(cwd, recvFlag) : path.join(dataRoot, 'recv');
  const stateDir = path.join(dataRoot, '.state');

  const loopbackOnly = flags.get('loopback') === true;

  return {
    port: getNumber(flags, 'port') ?? getNumber(flags, 'p') ?? 8787,
    host: loopbackOnly ? '127.0.0.1' : '0.0.0.0',
    recvDir,
    stateDir,
    chunkSize: getNumber(flags, 'chunk-size') ?? DEFAULT_CHUNK_SIZE,
    maxConcurrentChunks: getNumber(flags, 'concurrency') ?? 8,
    sessionTtlMs: (getNumber(flags, 'session-hours') ?? 24) * 3600_000,
    pairTtlMs: (getNumber(flags, 'pair-minutes') ?? 10) * 60_000,
    retentionMs: (getNumber(flags, 'retention-hours') ?? 24) * 3600_000,
    maxFileSize: (getNumber(flags, 'max-size-gb') ?? 64) * 1024 ** 3,
    syncClipboard: flags.get('no-clipboard') !== true,
    advertisedHost: getString(flags, 'host-ip'),
    verbose: flags.get('verbose') === true,
    loopbackOnly,
  };
}

const HELP_TEXT = `drop —— 手机与电脑之间的局域网互传工具

用法：
  drop serve [选项]              启动服务并打印二维码，手机扫码即可互传
  drop send <文件|文件夹...>      把电脑上的文件/文件夹推送给已连接的手机
  drop clip <文本|->             把文本推送到手机；用 - 从标准输入读取
  drop clip --pull               把电脑剪贴板内容推送到手机
  drop list                      列出最近的传输任务
  drop where                     打开接收目录（Windows 资源管理器）
  drop where --print             只打印接收目录路径
  drop help                      显示本帮助

serve 选项：
  -p, --port <端口>              监听端口（默认 8787，被占用时自动顺延）
      --dir <目录>               手机传来的文件落盘目录（默认 ./data/recv）
      --loopback                 只监听 127.0.0.1（本机调试用）
      --host-ip <IP>             二维码中使用的主机地址（多网卡时手动指定）
      --chunk-size <字节>        分片大小（默认 8388608）
      --concurrency <n>          并发分片上限（默认 8）
      --pair-minutes <分钟>      二维码有效时间（默认 10）
      --session-hours <小时>     会话有效时间（默认 24）
      --retention-hours <小时>   完成任务元数据保留时间（默认 24）
      --max-size-gb <GB>         单文件大小上限（默认 64）
      --no-clipboard             收到文本时不写入本机剪贴板
      --verbose                  打印详细日志
`;

export function helpText(): string {
  return HELP_TEXT;
}

// --- 内部工具 ---------------------------------------------------------------

function normalizeFlag(raw: string): string {
  let key = raw.replace(/^--?/, '');
  if (key.startsWith('no-')) key = key.slice(3);
  return key;
}

function isNegativeNumber(token: string): boolean {
  return /^-\d/.test(token);
}

function getString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function getNumber(flags: Map<string, string | boolean>, key: string): number | undefined {
  const raw = getString(flags, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
