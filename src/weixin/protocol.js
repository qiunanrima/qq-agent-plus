import { randomBytes, createDecipheriv, createHash } from 'node:crypto';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
export function officialBase(value = API_BASE) {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')))
    throw new Error('微信返回了不受信任的接口地址');
  return url.origin;
}
export const conversationKey = (account, peer) => `weixin:${createHash('sha256').update(account).digest('hex')}:${createHash('sha256').update(peer).digest('hex')}`;

// Preserve numeric uint64 identifiers before JSON.parse can round them.
export function parseWire(text) {
  return JSON.parse(text.replace(/("(?:message_id|seq|create_time_ms|update_time_ms)"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"'));
}

export class WeixinApi {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(endpoint, { account, base = account?.base || API_BASE, body, signal, timeoutMs = 40000 } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x020408) };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (account?.token) headers.Authorization = `Bearer ${account.token}`;
    }
    const scoped = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await this.fetch(`${officialBase(base)}/ilink/bot/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: scoped,
      ...(body === undefined ? {} : { body: JSON.stringify(account ? { ...body, base_info: { channel_version: '2.4.8', bot_agent: 'QQAgentPlus/0.9.14' } } : body) })
    });
    if (!response.ok) throw new Error(`微信 HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('微信响应超出限制');
    const result = parseWire(text);
    const code = [result.ret, result.errcode].find(value => value != null && value !== 0);
    if (code != null) { const error = new Error(`微信接口错误 ${Number(code)}`); error.code = Number(code); throw error; }
    return result;
  }
  async image(item, signal) {
    const media = item?.image_item?.media;
    const keyText = item?.image_item?.aeskey;
    const decoded = Buffer.from(media?.aes_key || '', 'base64');
    const key = keyText ? Buffer.from(keyText, 'hex') : decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString()) ? Buffer.from(decoded.toString(), 'hex') : decoded;
    if (key.length !== 16 || (!media?.encrypt_query_param && !media?.full_url)) throw new Error('图片缺少有效解密参数');
    const url = new URL(media.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`);
    if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new Error('图片地址不在微信官方 CDN');
    const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 4 * 1024 * 1024) throw new Error('微信图片下载失败或过大');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('微信图片超出限制'); chunks.push(chunk); }
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const bytes = Buffer.concat([decipher.update(Buffer.concat(chunks)), decipher.final()]);
    const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
      : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
        : bytes.subarray(0, 3).toString() === 'GIF' ? 'image/gif'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
    if (!mime) throw new Error('微信图片格式无法识别');
    return { type: 'image', mimeType: mime, data: bytes.toString('base64') };
  }
}
