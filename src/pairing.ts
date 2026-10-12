/**
 * 配对与鉴权。
 *
 * 威胁模型：同一局域网里可能有其他人。因此：
 *  - 二维码里带一个**一次性令牌**，但 PIN 绝不进 URL（URL 会留在浏览器历史、也会被截图）
 *  - 扫码进页面后必须手输 6 位 PIN，才能换到会话令牌
 *  - 会话令牌写进 `HttpOnly` Cookie，JS 读不到，降低 XSS 的收益
 *  - PIN 有尝试次数上限，防暴力枚举：6 位数字 = 100 万种，
 *    限速后在线枚举不可行
 *  - 配对窗口可随时关闭；关闭后旧的一次性令牌立即失效
 */

import crypto from 'node:crypto';

/** PIN 连续输错多少次就作废当前配对窗口。 */
const MAX_PIN_ATTEMPTS = 8;

export interface PairingState {
  /** 当前配对窗口的随机标识（每次刷新都变）。 */
  windowId: string;
  /** 6 位数字 PIN。 */
  pin: string;
  /** 一次性令牌，二维码里带的就是它。 */
  oneTimeToken: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  /** 已经用掉一次性令牌的会话，防止同一令牌换出多个会话。 */
  consumedTokens: Set<string>;
}

export interface PairingStatus {
  active: boolean;
  expiresAt: number;
  /** 剩余可尝试次数。 */
  attemptsLeft: number;
  secondsLeft: number;
}

export type PairResult =
  | { ok: true; sessionToken: string; expiresAt: number }
  | { ok: false; reason: 'no_window' | 'bad_pin' | 'bad_token' | 'expired' | 'too_many_attempts' };

export class Pairing {
  private state: PairingState | null = null;

  /**
   * 注意：这里用显式字段而不是构造函数参数属性——Node 的类型擦除模式
   * （strip-only）不支持参数属性，会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
   */
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** 生成新的配对窗口（旧窗口立即作废）。 */
  open(): PairingState {
    const now = Date.now();
    this.state = {
      windowId: crypto.randomBytes(8).toString('hex'),
      pin: randomPin(),
      oneTimeToken: crypto.randomBytes(24).toString('base64url'),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
      consumedTokens: new Set(),
    };
    return this.state;
  }

  close(): void {
    this.state = null;
  }

  current(): PairingState | null {
    if (!this.state) return null;
    if (this.state.expiresAt <= Date.now()) return null;
    return this.state;
  }

  status(): PairingStatus {
    const state = this.current();
    if (!state) {
      return { active: false, expiresAt: 0, attemptsLeft: 0, secondsLeft: 0 };
    }
    return {
      active: true,
      expiresAt: state.expiresAt,
      attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - state.attempts),
      secondsLeft: Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000)),
    };
  }

  /**
   * 用一次性令牌 + PIN 换取会话令牌。
   *
   * @param requestedTtlMs 会话有效期
   */
  async pair(
    oneTimeToken: string,
    pin: string,
    meta: { userAgent?: string; remoteAddress?: string } = {},
    requestedTtlMs = 24 * 3600_000,
  ): Promise<PairResult> {
    const state = this.current();
    if (!state) return { ok: false, reason: this.state ? 'expired' : 'no_window' };

    if (state.attempts >= MAX_PIN_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

    if (!timingSafeEqual(state.oneTimeToken, oneTimeToken)) {
      state.attempts += 1;
      return { ok: false, reason: 'bad_token' };
    }

    if (!timingSafeEqual(state.pin, normalizePin(pin))) {
      state.attempts += 1;
      return { ok: false, reason: 'bad_pin' };
    }

    // 一次性令牌只能换一个会话：换成功后立刻轮换，避免被重放。
    state.consumedTokens.add(state.oneTimeToken);
    state.oneTimeToken = crypto.randomBytes(24).toString('base64url');
    state.attempts = 0;

    const now = Date.now();
    return {
      ok: true,
      sessionToken: crypto.randomBytes(32).toString('base64url'),
      expiresAt: now + requestedTtlMs,
    };
  }
}

/** 生成 6 位数字 PIN（首位可以是 0）。 */
export function randomPin(): string {
  const value = crypto.randomInt(0, 1_000_000);
  return value.toString().padStart(6, '0');
}

/** 恒定时间比较，长度不同也不泄漏信息。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 仍然做一次比较，避免通过耗时区分"长度不对"和"内容不对"。
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 解析 Cookie 头。 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key) out.set(key, decodeURIComponent(value));
  }
  return out;
}

function normalizePin(pin: string): string {
  return String(pin ?? '').replace(/\D/g, '').slice(0, 6);
}
