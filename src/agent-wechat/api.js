import fs from 'node:fs';
import { readJsonBounded } from '../core/http-body.js';
import { normalizeWechatConfig } from './config.js';

export class AgentWechatApi {
  constructor(getConfig, fetchImpl = fetch) { this.getConfig = getConfig; this.fetch = fetchImpl; }
  async request(route, { body, key, signal, binary = false } = {}) {
    if (binary && !/^\/media\/[A-Za-z0-9_-]{1,200}\/content$/.test(route)) throw new Error('微信媒体路径无效');
    const c = normalizeWechatConfig(this.getConfig().agentWechat);
    const stat = fs.lstatSync(c.tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32'
      && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error('微信令牌文件权限无效');
    const token = fs.readFileSync(c.tokenFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_+/=-]{24,1024}$/.test(token)) throw new Error('微信令牌文件无效');
    const res = await this.fetch(`${c.endpoint}/v1/accounts/${encodeURIComponent(c.accountId)}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10000)])
    });
    if (!res.ok) throw new Error(`微信本地接口错误 (${res.status})`);
    if (binary) {
      const limit = 12 * 1024 * 1024, chunks = []; let size = 0;
      if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); throw new Error('微信图片超过 12 MiB'); }
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > limit) throw new Error('微信图片超过 12 MiB');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    return readJsonBounded(res, 2 * 1024 * 1024);
  }
}
