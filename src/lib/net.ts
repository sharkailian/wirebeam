/**
 * 网络辅助：挑选用于二维码的局域网地址，并处理端口占用顺延。
 */

import net from 'node:net';
import os from 'node:os';

export interface Candidate {
  address: string;
  iface: string;
  /** 评分越高越可能被手机访问到。 */
  score: number;
}

/**
 * 枚举本机所有 IPv4 地址，按"手机最可能连通"的顺序排序。
 *
 * 评分偏好：
 *  - 192.168.x.x（家用路由器最常见）
 *  - 10.x.x.x
 *  - 172.16-31.x.x
 *  - Android USB 网络共享 192.168.42.x / iPhone 个人热点 172.20.10.x
 */
export function listLanAddresses(): Candidate[] {
  const out: Candidate[] = [];
  const ifaces = os.networkInterfaces();

  for (const [iface, entries] of Object.entries(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push({ address: entry.address, iface, score: scoreAddress(entry.address, iface) });
    }
  }

  return out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

/** 首选地址；没有任何局域网地址时返回 undefined。 */
export function pickLanAddress(): Candidate | undefined {
  return listLanAddresses()[0];
}

function scoreAddress(address: string, iface: string): number {
  let score = 0;

  if (address.startsWith('192.168.42.')) score += 95; // Android USB 网络共享
  else if (address.startsWith('172.20.10.')) score += 90; // iPhone 个人热点
  else if (address.startsWith('192.168.')) score += 80;
  else if (address.startsWith('10.')) score += 70;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 60;
  else if (address.startsWith('169.254.')) score -= 50; // APIPA，几乎肯定不可用

  // 虚拟网卡常常排在前面，但手机连不上，降权。
  const lower = iface.toLowerCase();
  if (/virtual|vmware|vbox|hyper-v|loopback|wsl|docker|tap|tun/i.test(lower)) score -= 40;
  if (/wi-?fi|wlan|wireless/i.test(lower)) score += 15;
  if (/ethernet|以太网/i.test(lower)) score += 10;

  return score;
}

/**
 * 在 [start, start+span) 内找到一个可监听的端口。
 *
 * 返回实际拿到的端口；若全部被占用则抛错，由调用方决定如何提示。
 */
export async function findAvailablePort(
  host: string,
  start: number,
  span = 20,
): Promise<number> {
  for (let port = start; port < start + span; port += 1) {
    if (await canListen(host, port)) return port;
  }
  throw new Error(`端口 ${start}-${start + span - 1} 全部被占用，请用 --port 指定其他端口`);
}

function canListen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}
