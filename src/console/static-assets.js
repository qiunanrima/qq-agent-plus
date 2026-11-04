import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const ASSET_TOKEN_CACHE = new Map();
export function assetToken(fullPath) {
  const stat = fs.statSync(fullPath);
  const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const hit = ASSET_TOKEN_CACHE.get(fullPath);
  if (hit && hit.stamp === stamp) return hit.token;
  const token = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex').slice(0, 12);
  ASSET_TOKEN_CACHE.set(fullPath, { stamp, token });
  return token;
}

// 把 HTML 里"自家静态资源"的引用改成带内容哈希的 URL。只动以 / 开头、且没有查询串的路径：
// 外链（http(s):// 或 //cdn）与已经带 ?v= 的原样保留；目标文件不存在也原样保留
// （让正常路径去报 404，别在改写阶段把它吃掉）。
//
// **js 不在内**（2026-10-01，ui/ 转 ES module 之后）：浏览器按 URL 认模块 ——
// index.html 里带 ?v= 的 /core/dom.js，与模块内相对 import（./dom.js）解析出的
// /core/dom.js（相对路径解析不受父 URL 查询串影响），是两个不同的 URL，会各自求值一次，
// 于是同一份 state 变成两份实例（页面看着正常、状态不共享，极难查）。
// 所以 js 一律不带版本令牌、走 no-cache + 内容哈希 ETag 回源校验（真 304 仍然生效）；
// css/svg/png 不是模块，继续用 ?v= 换 immutable 长缓存。
export function rewriteAssetUrls(html, UI_DIR) {
  return html.replace(/(\s(?:src|href))="(\/[^"?#]+\.(?:css|svg|png))"/g, (whole, attr, urlPath) => {
    const target = path.join(UI_DIR, ...urlPath.slice(1).split('/'));
    const rel = path.relative(UI_DIR, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return whole;
    try {
      return `${attr}="${urlPath}?v=${assetToken(target)}"`;
    } catch {
      return whole;
    }
  });
}
