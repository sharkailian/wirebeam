/**
 * 静态资源服务。
 *
 * 只服务 web/ 目录下的白名单后缀，并且用"先解码再解析、最后校验是否在目录内"
 * 的方式挡住 `..` 与编码绕过。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface StaticOptions {
  root: string;
  /** 内联到 HTML 里的变量（例如启动时的默认文案）。 */
  headers?: Record<string, string>;
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  options: StaticOptions,
): Promise<boolean> {
  const relative = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');

  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return false;
  }

  // 拒绝任何穿越尝试（不做静默清洗，直接当作未命中）。
  if (decoded.includes('\0')) return false;
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/'));
  if (normalized.startsWith('..') || normalized.includes('/../')) return false;

  const rootAbs = path.resolve(options.root);
  const target = path.resolve(rootAbs, normalized.split('/').join(path.sep));
  const rel = path.relative(rootAbs, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;

  const ext = path.extname(target).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return false;

  let data: Buffer;
  try {
    data = await fs.readFile(target);
  } catch {
    return false;
  }

  const etag = `W/"${data.length.toString(16)}-${(data.length ^ ext.length).toString(16)}"`;
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(data.length),
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    ...(options.headers ?? {}),
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(data);
  return true;
}
