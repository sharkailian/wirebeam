/**
 * 命令行入口。
 *
 * 所有"让用户看到的东西"都集中在这里：二维码、进度提示、错误建议。
 * 业务逻辑一律不放在这个文件里，方便单测。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

import { buildConfig, helpText, parseArgs, type Config, type ParsedArgs } from './config.ts';
import { readClipboardText, writeClipboardText } from './clipboard.ts';
import { toTerminal } from './lib/qr.ts';
import { listLanAddresses } from './lib/net.ts';
import { readJson, readStateSnapshot, type PushTransfer } from './store.ts';
import { assertWebAssets, formatHost, startServer } from './server.ts';
import { diskSpace, formatBytes } from './routes.ts';

/** runtime.json 的内容：服务器启动时写入，供本地 CLI 使用。 */
interface RuntimeFile {
  port: number;
  url: string;
  host: string;
  pid: number;
  startedAt: number;
  controlToken: string;
  recvDir: string;
  hostName: string;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const config = buildConfig(parsed);

  switch (parsed.command) {
    case 'serve':
    case 'start':
      return await commandServe(config);
    case 'send':
      return await commandSend(config, parsed);
    case 'clip':
      return await commandClip(config, parsed);
    case 'list':
    case 'ls':
      return await commandList(config, parsed);
    case 'where':
    case 'dir':
      return await commandWhere(config, parsed);
    case 'selfcheck':
      return await commandSelfCheck(config);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText());
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write('dropsend 0.1.0\n');
      return 0;
    default:
      process.stderr.write(`未知命令：${parsed.command}\n\n${helpText()}`);
      return 2;
  }
}

// --- serve ------------------------------------------------------------------

async function commandServe(config: Config): Promise<number> {
  await assertWebAssets();

  const lanBefore = listLanAddresses();
  if (lanBefore.length === 0) {
    process.stderr.write(
      '\n⚠ 没有检测到局域网地址。手机将无法连接。\n' +
        '  请确认电脑已连接 WiFi 或网线，然后用 --host-ip 手动指定地址。\n\n',
    );
  }

  const server = await startServer({
    config,
    log: (message) => process.stdout.write(`  ${message}\n`),
  });

  const pairUrl = `${server.url}#t=${encodeURIComponent(server.oneTimeToken)}`;
  printBanner({
    url: server.url,
    pairUrl,
    pin: server.pin,
    recvDir: config.recvDir,
    pairingSeconds: Math.round((server.pairingExpiresAt - Date.now()) / 1000),
    addresses: server.addresses,
  });

  process.stdout.write('\n  用手机相机扫码，或手动访问上面的地址并输入 PIN。\n');
  process.stdout.write('  按 Ctrl+C 停止服务。\n\n');

  if (config.syncClipboard) {
    const probe = await writeClipboardText(`dropsend 已启动 ${new Date().toLocaleString()}`).catch(
      (error: Error) => ({ ok: false, reason: error.message, blocked: true, mechanism: 'powershell' as const }),
    );
    if (!probe.ok) {
      process.stdout.write(
        `  ⚠ 电脑剪贴板暂不可用：${probe.reason ?? '未知原因'}\n` +
          '    文本互传仍然可用（会保存在网页里），只是不会自动写进系统剪贴板。\n\n',
      );
    }
  }

  // 防火墙检测可能因为权限/策略失败，绝不能让整个服务起不来。
  await checkFirewall(server.port).catch(() => {});

  // 保持进程存活，直到 Ctrl+C。
  await new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  await server.stop();
  return 0;
}

interface BannerInput {
  url: string;
  pairUrl: string;
  pin: string;
  recvDir: string;
  pairingSeconds: number;
  addresses: { address: string; iface: string }[];
}

function printBanner(input: BannerInput): void {
  const line = '─'.repeat(64);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write('  dropsend —— 手机 ⇄ 电脑 局域网互传\n');
  process.stdout.write(`${line}\n\n`);

  // 终端二维码：直接扫这一屏就能配对。
  // 刻意不传 margin，用按 ISO/IEC 18004 的 4 模块静默区——
  // 静默区不够时手机相机可能对不上焦，而扫码是唯一的配对入口，不能赌。
  try {
    const qrLines = toTerminal(input.pairUrl, { ec: 'M' });
    for (const row of qrLines) process.stdout.write(`  ${row}\n`);
  } catch (error) {
    process.stdout.write(`  （二维码生成失败：${(error as Error).message}）\n`);
  }

  process.stdout.write(`\n  访问地址   ${input.url}\n`);
  process.stdout.write(`  配对 PIN   ${input.pin}     （${input.pairingSeconds} 秒内有效）\n`);
  process.stdout.write(`  接收目录   ${input.recvDir}\n`);

  if (input.addresses.length > 1) {
    process.stdout.write('\n  其他可用地址：\n');
    for (const item of input.addresses.slice(1, 5)) {
      process.stdout.write(`    http://${formatHost(item.address)}/  (${item.iface})\n`);
    }
  }
  process.stdout.write('\n');
}

/**
 * Windows 防火墙：首次运行时入站默认被拦，手机就会一直转圈。
 * 这里检查规则是否存在，不存在就尝试放行（需要管理员权限，失败也不阻塞）。
 */
async function checkFirewall(port: number): Promise<void> {
  if (process.platform !== 'win32') return;

  const ruleName = 'dropsend LAN transfer';
  const checkScript = [
    `$r = Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue`,
    'if ($r) { "exists" } else { "missing" }',
  ].join('\n');

  const check = await runPowerShell(checkScript);
  if (check.ok && check.stdout.trim() === 'exists') return;

  const addScript = [
    `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -Action Allow`,
    `-Protocol TCP -LocalPort ${port} -Profile Private,Domain | Out-Null`,
    '"created"',
  ].join(' ');

  const added = await runPowerShell(addScript);
  if (added.ok && added.stdout.includes('created')) {
    process.stdout.write(`  ✓ 已添加防火墙入站规则（TCP ${port}，仅专用/域网络）。\n\n`);
    return;
  }

  process.stdout.write(
    '  ⚠ 未能自动放行防火墙。如果手机打不开页面，请以管理员身份运行：\n' +
      `    New-NetFirewallRule -DisplayName 'dropsend LAN transfer' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Private,Domain\n\n`,
  );
}

// --- send -------------------------------------------------------------------

/**
 * 解释用户传入的相对路径时应当以哪个目录为基准。
 *
 * 本工具常通过 `drop.cmd` 启动，而启动器会先切到项目目录（好让数据目录固定），
 * 如果这里直接用 `process.cwd()`，`drop send 相对路径.txt` 就会在项目目录里
 * 而不是用户当时所在的目录里找文件——不符合命令行直觉。
 * 所以启动器把原始目录经由 `DROP_CWD` 传进来。
 */
function userCwd(): string {
  const fromEnv = process.env.DROP_CWD;
  return fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
}

async function commandSend(config: Config, parsed: ParsedArgs): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    process.stderr.write('用法：drop send <文件或文件夹...>\n');
    return 2;
  }

  const files: string[] = [];
  for (const target of targets) {
    const absolute = path.resolve(userCwd(), target);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      process.stderr.write(`找不到：${target}\n`);
      return 2;
    }
    if (stat.isDirectory()) {
      files.push(...(await collectFiles(absolute)));
    } else if (stat.isFile()) {
      files.push(absolute);
    }
  }

  if (files.length === 0) {
    process.stderr.write('没有可发送的文件。\n');
    return 2;
  }

  const runtime = await requireRunningServer(config);
  const totalBytes = await sumSizes(files);
  const name =
    targets.length === 1
      ? path.basename(path.resolve(userCwd(), targets[0]!))
      : `${targets.length} 个文件`;

  const response = await localFetch(runtime, '/api/push', {
    method: 'POST',
    body: JSON.stringify({ filePaths: files, name, note: '来自电脑的推送' }),
  });

  if (!response.ok) {
    process.stderr.write(`推送失败：${describeError(response)}\n`);
    return 1;
  }

  const transfer = (response.body as { transfer?: PushTransfer }).transfer;
  process.stdout.write(
    `已推送给手机：${name}\n` +
      `  ${files.length} 个文件，共 ${formatBytes(totalBytes)}\n` +
      `  任务号 ${transfer?.id ?? '(未知)'}\n` +
      '  手机浏览器上会立即出现下载提示。\n',
  );
  return 0;
}

// --- clip -------------------------------------------------------------------

/**
 * 读取要发送的文本。
 *
 * 顺序很重要：帮助里写的是 `drop clip -` 表示"从标准输入读"，
 * 所以 `-` 必须优先于"把位置参数拼起来"处理。
 * 早期版本漏了这一步，于是 `echo 内容 | drop clip -` 会把字面量 "-"
 * 发给手机——用户以为发了整段内容，实际只收到一个减号。
 *
 * 导出是为了让测试能直接覆盖这条真实出过错的判断逻辑。
 */
export async function resolveClipText(parsed: ParsedArgs): Promise<{ text: string; source: string }> {
  const wantsStdin = parsed.positional.includes('-');

  if (wantsStdin) {
    return { text: await readStdin(), source: '标准输入' };
  }

  if (parsed.positional.length > 0) {
    return { text: parsed.positional.join(' '), source: '命令行参数' };
  }

  // 没有参数但标准输入不是终端：说明是被管道接过来的，按整段文本处理。
  if (!process.stdin.isTTY) {
    return { text: await readStdin(), source: '标准输入' };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('输入要发送到手机的文本（回车发送）：');
    return { text: answer, source: '交互输入' };
  } finally {
    rl.close();
  }
}

/**
 * 清掉管道带来的尾随换行。
 *
 * 只去尾部的：中间的换行是用户内容，去掉就把多行文本压成一行了——
 * 这正是"发给手机的代码段变成一行"这类投诉的来源。
 */
export function trimTrailingNewlines(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '');
}

async function commandClip(config: Config, parsed: ParsedArgs): Promise<number> {
  const pull = parsed.flags.get('pull') === true;
  const runtime = await requireRunningServer(config);

  let text: string;
  let source: string;

  if (pull) {
    const read = await readClipboardText();
    if (!read.ok || !read.text) {
      process.stderr.write(
        `读取电脑剪贴板失败：${read.reason ?? '剪贴板为空'}\n` +
          (read.blocked ? '  提示：当前环境禁止启动 PowerShell，请在真实终端中运行。\n' : ''),
      );
      return 1;
    }
    text = read.text;
    source = '电脑剪贴板';
  } else {
    const resolved = await resolveClipText(parsed);
    text = resolved.text;
    source = resolved.source;
  }

  // 只去掉管道带来的尾随换行；中间的空行属于用户内容，必须原样保留。
  text = trimTrailingNewlines(text);

  if (!text || text.trim().length === 0) {
    process.stderr.write('文本为空，未发送。\n');
    return 2;
  }

  const response = await localFetch(runtime, '/api/clipboard/publish', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    process.stderr.write(`发送失败：${describeError(response)}\n`);
    return 1;
  }

  const lines = text.split('\n').length;
  process.stdout.write(`已发送到手机（来自${source}，${text.length} 字符${lines > 1 ? `，${lines} 行` : ''}）。\n`);
  return 0;
}

// --- where ------------------------------------------------------------------

/**
 * 打印（或打开）接收目录。
 *
 * 存在的理由很实际：终端上的二维码和提示会把"接收目录"那几行顶上去，
 * 用户传完文件后第一反应就是"东西存哪了"。
 */
async function commandWhere(config: Config, parsed: ParsedArgs): Promise<number> {
  const dir = config.recvDir;
  await fs.mkdir(dir, { recursive: true });

  process.stdout.write(`${dir}\n`);

  if (parsed.flags.get('print') === true) return 0;

  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  process.stdout.write(`（当前 ${entries.length} 项）\n`);

  if (process.platform === 'win32') {
    // explorer 打开目录成功时退出码也可能是 1，所以不检查退出码。
    const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {
      process.stderr.write('（无法自动打开资源管理器，请手动复制上面的路径）\n');
    });
    child.unref();
  }
  return 0;
}

// --- list -------------------------------------------------------------------

async function commandList(config: Config, parsed: ParsedArgs): Promise<number> {
  const asJson = parsed.flags.get('json') === true;
  const runtime = await readRuntime(config);
  const transfers = runtime ? await fetchTransfers(runtime) : await transfersFromDisk(config);

  if (transfers.length === 0) {
    process.stdout.write('还没有任何传输记录。\n');
    return 0;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(transfers, null, 2)}\n`);
    return 0;
  }

  const rows = transfers.slice(0, 30).map((item) => ({
    任务: item.id,
    方向: item.kind === 'upload' ? '手机→电脑' : '电脑→手机',
    名称: truncate(item.name, 28),
    大小: formatBytes(item.totalBytes),
    进度: `${formatBytes(item.doneBytes)} (${percent(item.doneBytes, item.totalBytes)})`,
    状态: statusLabel(item.status),
    时间: new Date(item.createdAt).toLocaleString(),
  }));

  process.stdout.write(`${renderTable(rows)}\n`);
  return 0;
}

// --- selfcheck --------------------------------------------------------------

/**
 * 自检：把最容易"环境相关"的环节逐个验证一遍，
 * 让用户能在真实终端里自己确认哪一项不可用。
 */
async function commandSelfCheck(config: Config): Promise<number> {
  process.stdout.write('dropsend 自检\n─────────────\n');

  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  process.stdout.write(`${mark(nodeOk)} Node 版本：${process.versions.node}（需要 >= 22）\n`);

  const addresses = listLanAddresses();
  process.stdout.write(`${mark(addresses.length > 0)} 局域网地址：${addresses.length > 0 ? addresses.map((a) => a.address).join(', ') : '未检测到'}\n`);

  const disk = await diskSpace(config.recvDir);
  process.stdout.write(`${mark(disk.free > 0)} 接收目录可用空间：${formatBytes(disk.free)}（${config.recvDir}）\n`);

  const writeProbe = path.join(os.tmpdir(), `dropsend-write-${Date.now()}.tmp`);
  let writable = true;
  try {
    await fs.writeFile(writeProbe, 'ok');
  } catch {
    writable = false;
  } finally {
    await fs.rm(writeProbe, { force: true }).catch(() => {});
  }
  process.stdout.write(`${mark(writable)} 临时目录可写：${os.tmpdir()}\n`);

  const clipWrite = await writeClipboardText('dropsend 自检');
  const clipRead = clipWrite.ok ? await readClipboardText() : { ok: false, text: '', reason: clipWrite.reason, blocked: clipWrite.blocked };
  const clipOk = clipWrite.ok && clipRead.ok && clipRead.text.trim().length > 0;
  process.stdout.write(`${mark(clipOk)} 剪贴板读写：${clipOk ? '正常' : (clipWrite.reason ?? clipRead.reason ?? '不可用')}\n`);
  if (!clipOk && (clipWrite.blocked ?? clipRead.blocked)) {
    process.stdout.write('    → 受限环境（沙箱/安全策略）禁止子进程通信，请在真实终端里重跑自检。\n');
  }

  // 本机回环端到端：起服务 → 配对 → 上传一小段数据 → 校验哈希。
  const loopback = await loopbackRoundTrip(config);
  process.stdout.write(`${mark(loopback.ok)} 回环传输（配对+分片+校验）：${loopback.detail}\n`);

  process.stdout.write('\n自检结束。\n');
  return 0;
}

/** 在 127.0.0.1 上真跑一遍完整协议：起服务、配对、上传、校验、关停。 */
async function loopbackRoundTrip(baseConfig: Config): Promise<{ ok: boolean; detail: string }> {
  const tmpRoot = path.join(os.tmpdir(), `dropsend-selfcheck-${crypto.randomBytes(4).toString('hex')}`);
  const localConfig: Config = {
    ...baseConfig,
    host: '127.0.0.1',
    port: 0,
    loopbackOnly: true,
    recvDir: path.join(tmpRoot, 'recv'),
    stateDir: path.join(tmpRoot, 'state'),
    syncClipboard: false,
    pairTtlMs: 60_000,
  };

  let server;
  try {
    server = await startServer({ config: localConfig, log: () => {} });
    const runtime: RuntimeFile = {
      port: server.port,
      url: `http://127.0.0.1:${server.port}/`,
      host: '127.0.0.1',
      pid: process.pid,
      startedAt: Date.now(),
      controlToken: server.controlToken,
      recvDir: localConfig.recvDir,
      hostName: 'selfcheck',
    };

    // 1) 用错误的 PIN 必须被拒
    const badPin = await localFetch(runtime, '/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: server.oneTimeToken, pin: '000000' }),
    });
    if (badPin.ok) return { ok: false, detail: '错误 PIN 竟然通过了鉴权' };

    // 2) 用正确 PIN 换会话
    const paired = await localFetch(runtime, '/api/session', {
      method: 'POST',
      body: JSON.stringify({ token: server.oneTimeToken, pin: server.pin }),
    });
    if (!paired.ok) return { ok: false, detail: `配对失败：${describeError(paired)}` };
    const cookie = paired.setCookie?.split(';')[0] ?? '';

    // 3) 造一段确定性数据并算哈希
    const payload = crypto.randomBytes(300 * 1024);
    const digest = crypto.createHash('sha256').update(payload).digest('hex');

    const created = await localFetch(runtime, '/api/transfers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        origin: 'folder',
        folderName: '自检文件夹',
        files: [{ relPath: '子目录/测试.bin', size: payload.length, sha256: digest, chunkSize: 64 * 1024 }],
      }),
    });
    if (!created.ok) return { ok: false, detail: `建任务失败：${describeError(created)}` };

    const transferId = (created.body as { transferId: string }).transferId;

    // 4) 逆序上传分片，顺便验证乱序也能正确重组
    const chunkSize = 64 * 1024;
    const indexes = Array.from({ length: Math.ceil(payload.length / chunkSize) }, (_, i) => i).reverse();
    for (const index of indexes) {
      const slice = payload.subarray(index * chunkSize, Math.min(payload.length, (index + 1) * chunkSize));
      const put = await localFetch(runtime, `/api/transfers/${transferId}/chunks/${index}?part=0`, {
        method: 'PUT',
        cookie,
        raw: slice,
      });
      if (!put.ok) return { ok: false, detail: `上传分片 ${index} 失败：${describeError(put)}` };
    }

    // 5) 重复上传同一分片必须幂等
    const duplicate = await localFetch(runtime, `/api/transfers/${transferId}/chunks/0?part=0`, {
      method: 'PUT',
      cookie,
      raw: payload.subarray(0, chunkSize),
    });
    if (!duplicate.ok || (duplicate.body as { duplicate?: boolean }).duplicate !== true) {
      return { ok: false, detail: '重复分片没有被识别为幂等' };
    }

    // 6) 完成并校验落盘文件
    const done = await localFetch(runtime, `/api/transfers/${transferId}/complete`, {
      method: 'POST',
      cookie,
      body: '{}',
    });
    if (!done.ok) return { ok: false, detail: `完成失败：${describeError(done)}` };

    const landed = path.join(localConfig.recvDir, '自检文件夹', '子目录', '测试.bin');
    const written = await fs.readFile(landed);
    const writtenDigest = crypto.createHash('sha256').update(written).digest('hex');
    if (writtenDigest !== digest) return { ok: false, detail: '落盘文件哈希不一致' };

    // 7) 路径穿越必须被拒
    const evil = await localFetch(runtime, '/api/transfers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ origin: 'file', files: [{ relPath: '../../逃逸.txt', size: 1 }] }),
    });
    if (evil.ok) return { ok: false, detail: '路径穿越竟然被接受' };

    return { ok: true, detail: `1 个文件 ${formatBytes(payload.length)}、乱序分片、幂等重传、哈希与路径防护全部通过` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  } finally {
    await server?.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// --- 本地 API 客户端 --------------------------------------------------------

interface LocalResponse {
  ok: boolean;
  status: number;
  body: unknown;
  setCookie?: string;
  error?: string;
}

async function localFetch(
  runtime: RuntimeFile,
  apiPath: string,
  options: { method?: string; body?: string; raw?: Buffer; cookie?: string } = {},
): Promise<LocalResponse> {
  const url = `http://127.0.0.1:${runtime.port}${apiPath}`;
  const headers: Record<string, string> = {
    'X-Drop-Token': runtime.controlToken,
  };
  if (options.cookie) headers.Cookie = options.cookie;

  let payload: BodyInit | undefined;
  if (options.raw) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = new Uint8Array(options.raw);
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = options.body;
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? undefined;
    return {
      ok: response.ok,
      status: response.status,
      body,
      ...(setCookie ? { setCookie } : {}),
    };
  } catch (error) {
    return { ok: false, status: 0, body: undefined, error: (error as Error).message };
  }
}

function describeError(response: LocalResponse): string {
  if (response.error) return response.error;
  const body = response.body as { error?: string } | undefined;
  return body?.error ?? `HTTP ${response.status}`;
}

async function readRuntime(config: Config): Promise<RuntimeFile | undefined> {
  const runtime = await readJson<RuntimeFile>(path.join(config.stateDir, 'runtime.json'));
  if (!runtime) return undefined;
  // 进程可能已经退出但文件还在，探测一下。
  try {
    await fetch(`http://127.0.0.1:${runtime.port}/api/pair/info`, { signal: AbortSignal.timeout(1500) });
    return runtime;
  } catch {
    return undefined;
  }
}

async function requireRunningServer(config: Config): Promise<RuntimeFile> {
  const runtime = await readRuntime(config);
  if (!runtime) {
    throw new Error('没有正在运行的 dropsend 服务。请先在另一个终端执行：drop serve');
  }
  return runtime;
}

async function fetchTransfers(runtime: RuntimeFile): Promise<TransferSummary[]> {
  // /api/transfers 需要会话；本地 CLI 用控制令牌替代，服务端同样放行。
  const response = await localFetch(runtime, '/api/transfers');
  if (response.ok) {
    const body = response.body as { transfers?: TransferSummary[] } | undefined;
    return body?.transfers ?? [];
  }
  return [];
}

async function transfersFromDisk(config: Config): Promise<TransferSummary[]> {
  const snapshot = await readStateSnapshot(config.stateDir);
  return (snapshot?.transfers ?? []).map((record) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    name: record.name,
    totalBytes: record.totalBytes,
    doneBytes: record.doneBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

interface TransferSummary {
  id: string;
  kind: 'upload' | 'push';
  status: string;
  name: string;
  totalBytes: number;
  doneBytes: number;
  createdAt: number;
  updatedAt: number;
}

// --- 小工具 -----------------------------------------------------------------

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out;
}

async function sumSizes(files: readonly string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat) total += stat.size;
  }
  return total;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function runPowerShell(script: string): Promise<{ ok: boolean; stdout: string; reason?: string }> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true },
      );
    } catch (error) {
      // 受限环境可能直接禁止创建子进程：返回失败而不是抛异常。
      resolve({ ok: false, stdout: '', reason: (error as Error).message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, reason: '执行超时' });
    }, 15_000);
    timer.unref?.();

    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (error) => finish({ ok: false, stdout, reason: error.message }));
    child.on('close', (code) =>
      code === 0
        ? finish({ ok: true, stdout })
        : finish({ ok: false, stdout, reason: stderr.trim() || `退出码 ${code}` }),
    );
  });
}

function mark(ok: boolean): string {
  return ok ? '✓' : '✗';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function percent(done: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.floor((done / total) * 100)}%`;
}

function statusLabel(status: string): string {
  return (
    {
      active: '进行中',
      done: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }[status] ?? status
  );
}

/** 等宽表格：按显示宽度（中文算 2 列）对齐。 */
function renderTable(rows: Record<string, string>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((col) =>
    Math.max(displayWidth(col), ...rows.map((row) => displayWidth(row[col] ?? ''))),
  );

  const header = columns.map((col, i) => pad(col, widths[i]!)).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');
  const body = rows.map((row) =>
    columns.map((col, i) => pad(row[col] ?? '', widths[i]!)).join('  '),
  );
  return [header, separator, ...body].join('\n');
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // 粗略判定：CJK、全角标点算两列。
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6))
      ? 2
      : 1;
  }
  return width;
}

function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}
