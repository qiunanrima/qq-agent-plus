import { HealthError } from './errors.mjs';
import { randomBytes } from 'node:crypto';
import { encryptedParams, decryptResponse, sha1Base64 } from './crypto.mjs';

const ACCOUNT = 'https://account.xiaomi.com';
const STS = 'https://sts-hlth.io.mi.com/healthapp/sts';
const API = 'https://hlth.io.mi.com';
const HOSTS = new Set(['account.xiaomi.com', 'sts-hlth.io.mi.com', 'hlth.io.mi.com']);
const UA = 'Dalvik/2.1.0 (Linux; U; Android 12; V2284A) APP/mi.health APPV/353001 SDKV/5.3.0.release.68';

const isAccountHost = hostname => hostname === 'account.xiaomi.com' || hostname.endsWith('.account.xiaomi.com');
function trustedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HealthError('小米登录地址格式异常，请重新扫码'); }
  if (url.protocol !== 'https:' || !(HOSTS.has(url.hostname) || isAccountHost(url.hostname)) || url.port || url.username || url.password) {
    throw new HealthError('小米返回了不受支持的登录地址，请重新登录');
  }
  return url;
}
function json(text) {
  try { return JSON.parse(String(text).replace(/^&&&START&&&\s*/, '')); }
  catch { throw new HealthError('小米响应格式异常，请稍后重试'); }
}
function validToken(token) {
  return token && ['service_token', 'ssecurity', 'c_user_id', 'user_id']
    .every(key => typeof token[key] === 'string' && token[key] && !/[\r\n;]/.test(token[key]));
}

// Cookie jars are keyed by exact host. Account-wide passToken never goes to the health API.
export class XiaomiClient {
  constructor(request, save, now = Date.now) {
    this.request = request;
    this.save = save;
    this.now = now;
    this.token = null;
    this.login = null;
    this.cookies = new Map();
  }
  load(raw) {
    if (!raw) { this.token = null; return; }
    const token = json(raw);
    if (!validToken(token)) throw new HealthError('已保存的小米凭据不完整，请重新扫码');
    this.token = token;
  }
  jar(host) {
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    return this.cookies.get(host);
  }
  async http(value, headers = {}) {
    const url = trustedUrl(value);
    const jar = this.jar(url.hostname);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await this.request({ url: url.href, method: 'GET', redirect: 'manual',
      withSetCookies: true, maxChars: 500000,
      headers: { 'user-agent': UA, 'accept-encoding': 'identity', ...(cookie ? { cookie } : {}), ...headers } });
    if (r.truncated) throw new HealthError('小米响应过大，请缩短查询范围');
    for (const line of r.setCookies || []) {
      const pair = String(line).split(';')[0];
      const at = pair.indexOf('=');
      if (at > 0 && !/[\r\n]/.test(pair)) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return r;
  }
  async follow(value) {
    let url = trustedUrl(value);
    const credentials = {};
    for (let i = 0; i < 6; i++) {
      // STS may return the credential in Location rather than Set-Cookie.
      // Only harvest health credentials from the exact health STS host.
      if (url.hostname === 'sts-hlth.io.mi.com' || isAccountHost(url.hostname)) {
        for (const key of ['serviceToken', 'cUserId']) {
          const value = url.searchParams.get(key);
          if (value && !/[\r\n;]/.test(value)) credentials[key] = value;
        }
      }
      const r = await this.http(url.href);
      for (const key of ['serviceToken', 'cUserId']) {
        const value = this.jar(url.hostname).get(key);
        if (value && (url.hostname === 'sts-hlth.io.mi.com' || isAccountHost(url.hostname))) {
          credentials[key] = value;
        }
      }
      if (r.status >= 300 && r.status < 400 && r.location) {
        const next = trustedUrl(new URL(r.location, url).href);
        for (const key of ['serviceToken', 'cUserId']) {
          const value = next.searchParams.get(key);
          if (value && !/[\r\n;]/.test(value)) credentials[key] ||= value;
        }
        // Match upstream loginQr: consume credentials from this response, not
        // from a subsequent redirect which may clear or replace its cookies.
        if (credentials.serviceToken) return credentials;
        url = next;
        continue;
      }
      if (r.status !== 200) throw new HealthError('小米登录回跳失败，请重新扫码');
      return credentials;
    }
    throw new HealthError('小米登录跳转过多，请重新扫码');
  }
  async start() {
    this.login = null;
    this.cookies.clear();
    const device = `an_${randomBytes(16).toString('hex')}`;
    this.jar('account.xiaomi.com').set('deviceId', device);
    const query = new URLSearchParams({ _qrsize: '480', qs: '%3Fsid%3Dmiothealth%26_json%3Dtrue',
      callback: STS, _hasLogo: 'false', sid: 'miothealth', serviceParam: '', _locale: 'zh_CN', _dc: String(this.now()) });
    const r = await this.http(`${ACCOUNT}/longPolling/loginUrl?${query}`);
    if (r.status !== 200) throw new HealthError('无法获取小米登录二维码');
    const data = json(r.body);
    const poll = trustedUrl(data.lp);
    const loginUrl = trustedUrl(data.loginUrl);
    if (!isAccountHost(poll.hostname) || !isAccountHost(loginUrl.hostname)) {
      throw new HealthError('小米登录地址异常');
    }
    const seconds = Number(data.timeout);
    const expiresIn = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 300;
    this.login = { poll: poll.href, device, expiresAt: this.now() + expiresIn * 1000 };
    this.jar(poll.hostname).set('deviceId', device);
    return { loginUrl: loginUrl.href, expiresIn };
  }
  async exchange(token) {
    const query = new URLSearchParams({ d: token.device_id, ticket: '0', pwd: '0',
      p_ts: String(this.now()), fid: '0', p_lm: '2', p_ur: 'CN', sid: 'hlth.io.mi.com' });
    const jar = this.jar('sts-hlth.io.mi.com');
    if (token.service_token) jar.set('serviceToken', token.service_token);
    jar.set('deviceId', token.device_id);
    jar.set('userId', token.user_id);
    if (token.c_user_id) jar.set('cUserId', token.c_user_id);
    const r = await this.http(`${STS}?${query}`);
    if (r.status !== 200 || String(r.body).trim() !== 'ok') throw new HealthError('小米健康登录交换失败，请重新扫码');
    token.service_token = jar.get('serviceToken') || token.service_token;
  }
  async finish(data, device) {
    const token = { user_id: String(data.userId || ''), c_user_id: String(data.cUserId || ''),
      ssecurity: String(data.ssecurity || ''), pass_token: String(data.passToken || ''), device_id: device, service_token: '' };
    if (!token.user_id || !token.ssecurity || !data.location) throw new HealthError('小米未返回完整登录信息，请重新扫码');
    const location = trustedUrl(data.location);
    // Upstream adds clientSign only for passToken refresh, not for QR login.
    if (data.refresh && data.nonce) location.searchParams.set('clientSign', sha1Base64(`nonce=${data.nonce}&${token.ssecurity}`));
    const recovered = await this.follow(location.href);
    token.service_token = recovered.serviceToken || this.jar('sts-hlth.io.mi.com').get('serviceToken') || '';
    // Xiaomi does not consistently include cUserId in the polling JSON. It can
    // instead be supplied in a polling/STS response cookie or the STS Location.
    token.c_user_id ||= recovered.cUserId || this.accountCookie('cUserId');
    await this.exchange(token);
    token.c_user_id ||= this.jar('sts-hlth.io.mi.com').get('cUserId') || this.accountCookie('cUserId');
    if (!validToken(token)) {
      const labels = { user_id: '用户标识', c_user_id: '加密用户标识', service_token: '健康会话', ssecurity: '会话密钥' };
      const missing = Object.keys(labels).filter(key => !token[key]).map(key => labels[key]);
      throw new HealthError(`小米登录响应缺少${missing.join('、') || '有效凭据'}；未覆盖原有登录，请在更新插件后重新扫码`);
    }
    await this.save(JSON.stringify(token));
    this.token = token;
  }
  accountCookie(name) {
    for (const [host, jar] of this.cookies) {
      if (isAccountHost(host) && jar.get(name)) return jar.get(name);
    }
    return '';
  }
  async poll() {
    if (!this.login || this.now() >= this.login.expiresAt) {
      this.login = null;
      throw new HealthError('二维码不存在或已过期，请重新扫码');
    }
    let r;
    try { r = await this.http(this.login.poll); }
    catch (error) {
      // Long polling may expire before the QR does; retry only the read on the next UI poll.
      if (/timeout|超时/i.test(error.message)) return { state: 'waiting' };
      throw error;
    }
    if (r.status !== 200) {
      if ([408, 204].includes(r.status)) return { state: 'waiting' };
      throw new HealthError('小米扫码状态异常，请重新扫码');
    }
    const data = json(r.body);
    if (!data.ssecurity) {
      if ([0, 70016].includes(Number(data.code))) return { state: 'waiting' };
      this.login = null;
      throw new HealthError('扫码未完成或已失效，请重新扫码');
    }
    const device = this.login.device;
    this.login = null;
    await this.finish(data, device);
    return { state: 'done' };
  }
  async refresh() {
    const token = this.token;
    if (!token?.pass_token) throw new HealthError('小米登录已过期，请重新扫码');
    this.cookies.clear();
    const jar = this.jar('account.xiaomi.com');
    jar.set('passToken', token.pass_token);
    jar.set('userId', token.user_id);
    jar.set('deviceId', token.device_id);
    const r = await this.http(`${ACCOUNT}/pass/serviceLogin?_json=true&sid=miothealth`);
    if (r.status !== 200) throw new HealthError('小米登录已过期，请重新扫码');
    const data = json(r.body);
    await this.finish({ ...data, userId: data.userId || token.user_id,
      cUserId: data.cUserId || token.c_user_id, passToken: data.passToken || token.pass_token, refresh: true }, token.device_id);
  }
  async aggregate(key, days, retry = true) {
    if (!validToken(this.token)) throw new HealthError('请先在控制台扫码登录小米运动健康');
    const end = Math.floor((Math.floor((this.now() + 8 * 3600000) / 86400000) + 1) * 86400 - 8 * 3600 - 1);
    const path = '/app/v1/data/get_aggregated_fitness_data_by_time';
    const params = encryptedParams('GET', path, this.token.ssecurity, { relative_uid: this.token.user_id,
      key, tag: 'daily_report', start_time: end - days * 86400 + 1, end_time: end, limit: days });
    const jar = this.jar('hlth.io.mi.com');
    jar.clear();
    jar.set('cUserId', this.token.c_user_id);
    jar.set('serviceToken', this.token.service_token);
    const r = await this.http(`${API}${path}?${new URLSearchParams(params)}`, { region_tag: 'cn', handleparams: 'true' });
    if (r.status === 401 && retry) { await this.refresh(); return this.aggregate(key, days, false); }
    if (r.status !== 200) throw new HealthError(`小米健康查询失败（HTTP ${Number(r.status) || 0}），请检查登录状态`);
    let data;
    try { data = decryptResponse(this.token.ssecurity, params._nonce, r.body); }
    catch { throw new HealthError('小米健康响应解密失败，请重新扫码'); }
    if (Number(data?.code) === -4002004) return [];
    if (Number(data?.code) !== 0) throw new HealthError('小米健康拒绝查询，请检查登录或数据同步状态');
    return Array.isArray(data?.result?.data_list) ? data.result.data_list.slice(0, days) : [];
  }
}

export { trustedUrl, validToken };
