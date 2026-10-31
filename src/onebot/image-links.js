// 文本中的直链图片 → 有界磁盘缓存 → 普通消息图片。不会解析网页里的嵌套图片。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../core/config.js';
import { imageType } from '../core/image-type.js';
import { safeFetchBinary } from '../llm/safe-fetch.js';

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_FILES = 256;
const TTL_MS = 10 * 60 * 1000;
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'image-links');
const keyOf = (url) => crypto.createHash('sha256').update(url).digest('hex');
const filename = (key) => /^[a-f0-9]{64}$/.test(String(key || '')) ? path.join(CACHE_DIR, `${key}.img`) : '';

export function imageLinkCandidates(text) {
  const urls = [];
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"'\u3000\u3010\u3011，。！？；：、（）]+/gi)) {
    let raw = match[0].replace(/[\]）。，、！？；：,.!?;:]+$/u, '');
    while (raw.endsWith(')') && (raw.match(/\)/g) || []).length > (raw.match(/\(/g) || []).length) raw = raw.slice(0, -1);
    try {
      const url = new URL(raw);
      if (url.username || url.password) continue;
      url.hash = '';
      const value = url.href;
      if (!urls.includes(value)) urls.push(value);
    } catch { /* 坏链接仍作为正文保留 */ }
    if (urls.length === 4) break;
  }
  return urls;
}

// 从原始段读取，不能只扫描 cardToText 的展示摘要：摘要会省略 .png 等图片链接。
// 卡片的跳转链接优先，图标/封面不当成用户分享的正文图片。
export function imageLinkTextFromSegments(segments, fallbackText = '') {
  if (!Array.isArray(segments)) return String(fallbackText || '');
  const chunks = [];
  const targets = [];
  let visited = 0;
  const walk = (value, depth = 0, key = '') => {
    if (++visited > 512 || depth > 8) return;
    if (/^(?:icon|preview|cover|thumb(?:nail)?|avatar|image|pic)(?:url)?$/i.test(key)) return;
    if (typeof value === 'string') {
      if (value.length > 65536) return;
      if (/^(?:url|jump_?url|qqdocurl|href|target_?url|content_?jump_?url)$/i.test(key)) targets.push(value);
      else chunks.push(value);
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        walk(child, depth + 1, name);
        if (visited > 512) break;
      }
    }
  };
  for (const segment of segments) {
    if (segment?.type === 'text') chunks.push(String(segment.data?.text || ''));
    if (!['json', 'xml'].includes(segment?.type)) continue;
    const raw = segment.data?.data;
    if (raw && typeof raw === 'object') walk(raw);
    else if (typeof raw === 'string' && raw.length <= 262144) {
      try { walk(JSON.parse(raw)); }
      catch {
        // XML 卡片：只读取跳转属性和文字，不把封面图片/图标属性混进来。
        const source = raw.replace(/&amp;/gi, '&').replace(/\\\//g, '/');
        for (const match of source.matchAll(/\b(?:url|jump_?url|href|qqdocurl)\s*=\s*["']([^"']+)["']/gi)) targets.push(match[1]);
        chunks.push(source.replace(/<[^>]*>/g, ' '));
      }
    }
    if (visited > 512) break;
  }
  return [...targets, ...chunks].join('\n');
}

export async function readCachedImageLink(key) {
  const file = filename(key);
  if (!file) return null;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES || Date.now() - stat.mtimeMs > TTL_MS) return null;
    const buffer = await fs.readFile(file);
    const mime = imageType(buffer);
    return mime ? { buffer, mime } : null;
  } catch { return null; }
}

async function trimCache(incomingBytes) {
  const entries = [];
  for (const name of await fs.readdir(CACHE_DIR)) {
    if (!/^[a-f0-9]{64}\.img$/.test(name)) continue;
    const file = path.join(CACHE_DIR, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) entries.push({ file, size: stat.size, at: stat.mtimeMs });
    } catch { /* 并发清理 */ }
  }
  entries.sort((a, b) => a.at - b.at);
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let count = entries.length;
  for (const entry of entries) {
    if (Date.now() - entry.at <= TTL_MS && bytes + incomingBytes <= MAX_CACHE_BYTES && count < MAX_CACHE_FILES) break;
    await fs.unlink(entry.file).catch(() => {});
    bytes -= entry.size;
    count--;
  }
}

// 写入串行化：不同会话并发缓存时也遵守总容量上限。
let writeQueue = Promise.resolve();
async function saveImage(key, buffer) {
  const work = writeQueue.then(async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await trimCache(buffer.length);
    const target = filename(key);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, buffer, { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  });
  writeQueue = work.catch(() => {});
  return work;
}

export async function cacheImageLinks(text, { media = [], signal } = {}) {
  const existing = new Set(media.map((item) => String(item?.url || '')));
  const urls = imageLinkCandidates(text).filter((url) => !existing.has(url));
  if (!urls.length) return [];
  const deadline = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const results = [];
  // 限为每条消息 4 个、单图 12 MiB、整次 8 秒，避免链接消息阻塞接入队列。
  for (const url of urls) {
    if (combined.aborted) break;
    try {
      const cacheKey = keyOf(url);
      const cached = await readCachedImageLink(cacheKey);
      if (!cached) {
        const { buffer } = await safeFetchBinary(url, MAX_BYTES, combined, {
          allowPrivate: false,
          acceptContentType: (type) => /^(image\/|application\/octet-stream(?:;|$)|$)/i.test(type)
        });
        const mime = imageType(buffer);
        if (!mime) continue; // 不信扩展名或 Content-Type：HTML 伪装成图片也不能进入模型。
        combined.throwIfAborted();
        await saveImage(cacheKey, buffer);
      }
      results.push({ kind: 'image', url, cacheKey, summary: '链接图片' });
    } catch { /* 探测失败不能丢掉原消息，也不重试 */ }
  }
  return results;
}
