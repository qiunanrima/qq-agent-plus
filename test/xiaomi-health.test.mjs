import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHealthService, normalizeMetric } from '../examples/plugins/xiaomi-health/service.mjs';
import { XiaomiClient, trustedUrl } from '../examples/plugins/xiaomi-health/client.mjs';
import { rc4, signedNonce } from '../examples/plugins/xiaomi-health/crypto.mjs';
import { parsePluginManifest } from '../src/plugins/manifest.js';
import { PluginHost } from '../src/plugins/host.js';
import { createCapabilities } from '../src/plugins/capabilities.js';
import { HealthError, hostError, publicError } from '../examples/plugins/xiaomi-health/errors.mjs';
import { explicitHealthRead } from '../src/plugins/health-read-consent.js';

const NOW = Date.parse('2026-11-04T16:30:00Z'); // China is already Nov 5.
const SECURITY = Buffer.alloc(32, 7).toString('base64');
const token = { user_id: '123456789012345678', c_user_id: 'c-user', service_token: 'health-secret',
  ssecurity: SECURITY, pass_token: 'account-secret', device_id: 'device' };
const consoleContext = { channel: 'console', chatKey: '' };
const owner = { senderIsOwner: true, chatKey: 'private:12345' };

test('health: actionable local errors survive RPC; upstream credentials and URLs never escape', () => {
  assert.match(publicError(new HealthError('请先保存设置')).message, /保存设置/);
  const raw = new Error('DNS 解析超时 https://account.xiaomi.com/?token=secret');
  const safe = publicError(hostError(raw));
  assert.match(safe.message, /超时/);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(publicError(raw)).includes('secret'), false);
});

function fixture({ accepted = true, session = '', expired = false, now = NOW, allowAgentRead = true } = {}) {
  const calls = [];
  const notices = [];
  const values = { session };
  let expiry = expired;
  const http = async params => {
    calls.push(params);
    const url = new URL(params.url);
    if (url.pathname === '/longPolling/loginUrl') return { status: 200, body: JSON.stringify({
      lp: 'https://c3.lp.account.xiaomi.com/poll?ticket=qr-secret',
      loginUrl: 'https://c3.account.xiaomi.com/longPolling/login?ticket=qr-secret', timeout: 300 }) };
    if (url.pathname === '/poll' || url.pathname === '/pass/serviceLogin') return { status: 200,
      body: '&&&START&&&' + JSON.stringify({ code: 0, userId: token.user_id, cUserId: token.c_user_id,
        ssecurity: SECURITY, passToken: token.pass_token, location: 'https://sts-hlth.io.mi.com/ticket?auth=ticket-secret' }) };
    if (url.pathname === '/ticket') return { status: 302, location: 'https://sts-hlth.io.mi.com/land',
      setCookies: ['serviceToken=health-secret; Path=/; Secure'] };
    if (url.pathname === '/land') return { status: 200, body: 'ok' };
    if (url.pathname === '/healthapp/sts') return { status: 200, body: 'ok' };
    if (url.pathname.includes('get_aggregated')) {
      if (expiry) { expiry = false; return { status: 401, body: '' }; }
      const key = signedNonce(SECURITY, url.searchParams.get('_nonce'));
      const request = JSON.parse(Buffer.from(rc4(Buffer.from(key, 'base64'), Buffer.from(url.searchParams.get('data'), 'base64'))).toString());
      assert.equal(request.relative_uid, token.user_id);
      assert.equal(request.end_time, (Math.floor((now + 28800000) / 86400000) + 1) * 86400 - 28801);
      const payload = { code: 0, result: { data_list: [{ time: request.start_time,
        value: JSON.stringify({ steps: 1234, total_duration: 420, avg_hr: 68, unexpected: 'never expose' }) }] } };
      return { status: 200, body: Buffer.from(rc4(Buffer.from(key, 'base64'), Buffer.from(JSON.stringify(payload)))).toString('base64') };
    }
    throw new Error('Unexpected URL');
  };
  const callHost = async (method, params) => {
    if (method === 'cap.config.get') return { settings: { acceptUnofficial: accepted, allowAgentRead } };
    if (method === 'cap.send.text') { notices.push(params); return { ok: true }; }
    if (method === 'cap.secrets.get') return { values };
    if (method === 'cap.secrets.set') { Object.assign(values, params.values); return { ok: true }; }
    if (method === 'cap.http.request') return http(params);
    throw new Error('Unexpected capability');
  };
  return { calls, notices, values, http, callHost, service: createHealthService(callHost, () => now) };
}

test('health: agent read requires explicit switch, console probe stays available, notices contain no data', async () => {
  for (const allowAgentRead of [false, undefined]) {
    const f = fixture({ session: JSON.stringify(token) });
    let secretReads = 0;
    const service = createHealthService((method, params) => {
      if (method === 'cap.config.get') return { settings: { acceptUnofficial: true, allowAgentRead } };
      if (method === 'cap.secrets.get') secretReads++;
      return f.callHost(method, params);
    }, () => NOW);
    assert.equal((await service.call('query', {}, owner)).code, 'E_READ_DISABLED');
    assert.equal(secretReads, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.notices.length, 0);
    assert.equal((await service.probe()).login, true);
    assert.equal(f.notices.length, 0);
  }
  const f = fixture({ session: JSON.stringify(token) });
  await f.service.call('query', { metric: 'sleep', days: 2 }, owner);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].chatKey, owner.chatKey);
  assert.match(f.notices[0].text, /睡眠（最近 2 天）/);
  assert.equal(f.notices[0].text.includes('420'), false);
  const blocked = fixture({ session: JSON.stringify(token) });
  const service = createHealthService((method, params) => {
    if (method === 'cap.send.text') throw new Error('send unavailable');
    return blocked.callHost(method, params);
  }, () => NOW);
  assert.equal((await service.call('query', {}, owner)).code, 'E_NOTICE_FAILED');
  assert.equal(blocked.calls.length, 0);
});

test('health: explicit owner request exempts only matching metrics and range; model args cannot suppress notices', async () => {
  assert.deepEqual(explicitHealthRead('查一下我今天的步数'), { metrics: ['steps'], days: 1 });
  assert.equal(explicitHealthRead('不要查我的步数'), null);
  assert.equal(explicitHealthRead('今天好累'), null);
  const f = fixture({ session: JSON.stringify(token) });
  const context = { ...owner, explicitHealthRead: explicitHealthRead('查最近3天的步数') };
  await f.service.call('query', { metric: 'steps', days: 3 }, context);
  assert.equal(f.notices.length, 0);
  await f.service.call('query', { metric: 'sleep' }, context);
  assert.equal(f.notices.length, 1);
  await f.service.call('query', { metric: 'steps', days: 4 }, context);
  assert.equal(f.notices.length, 2);
  await f.service.call('query', { metric: 'steps', explicitHealthRead: context.explicitHealthRead }, owner);
  assert.equal(f.notices.length, 3);
  const blocked = fixture({ session: JSON.stringify(token), allowAgentRead: false });
  assert.equal((await blocked.service.call('query', { metric: 'steps' }, context)).code, 'E_READ_DISABLED');
});

test('health: permission guards reject groups, non-owner and forged channel before reading secrets/network', async () => {
  const f = fixture();
  for (const context of [{}, { senderIsOwner: true, chatKey: 'group:12345' }, { chatKey: 'private:12345' }]) {
    await assert.rejects(f.service.call('query', { channel: 'console' }, context), /管理员/);
    await assert.rejects(f.service.call('login', { action: 'start', channel: 'console' }, context), /管理员/);
  }
  await assert.rejects(f.service.call('login', { action: 'start', channel: 'console' }, owner), /控制台/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.values.session, '');
});

test('health: consent defaults closed, invalid query makes no network request', async () => {
  const f = fixture({ accepted: false });
  await assert.rejects(f.service.call('login', { action: 'start' }, consoleContext), /非官方/);
  for (const args of [{ days: 8 }, { days: 0 }, { days: true }, { days: [] }, { days: '1e0' }, { metric: 'gps' }]) {
    const result = await f.service.call('query', args, owner);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_ARGS');
    assert.match(result.error, /metric/);
  }
  assert.equal(f.calls.length, 0);
});

test('health: model numeric strings and metric aliases preserve bounded read queries', async () => {
  const f = fixture({ session: JSON.stringify(token) });
  for (const metric of ['heartRate', '心率', 'heart-rate']) {
    const r = await f.service.call('query', { metric, days: ' 2 ' }, owner);
    assert.equal(r.ok, true);
    assert.equal(r.days, 2);
    assert.equal(r.data.heart_rate.length, 1);
  }
});

test('health: QR→redirect cookies→STS→encrypted secrets→query; no tokens in public outputs', async () => {
  const f = fixture();
  const start = await f.service.call('login', { action: 'start' }, consoleContext);
  assert.match(start.qrcodeDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal('loginUrl' in start, false);
  assert.equal(start.expiresIn, 300);
  const poll = await f.service.call('login', { action: 'poll' }, consoleContext);
  assert.equal(poll.state, 'done');
  assert.equal(JSON.parse(f.values.session).user_id, token.user_id);
  const result = await f.service.call('query', { days: 2 }, owner);
  assert.equal(result.data.steps[0].steps, 1234);
  assert.equal(result.data.sleep[0].total_duration, 420);
  assert.equal(result.data.heart_rate[0].avg_hr, 68);
  const exposed = JSON.stringify([poll, result, await f.service.probe()]);
  for (const secret of [token.user_id, token.service_token, token.pass_token, SECURITY, 'unexpected', 'ticket-secret']) {
    assert.equal(exposed.includes(secret), false, `must not expose ${secret}`);
  }
  assert.equal(f.calls.some(p => new URL(p.url).pathname === '/land'), false, 'upstream captures redirect credential without following');
  const exchange = f.calls.find(p => new URL(p.url).pathname === '/healthapp/sts');
  assert.match(exchange.headers.cookie, /serviceToken=health-secret/);
  for (const p of f.calls.filter(p => new URL(p.url).hostname !== 'account.xiaomi.com')) {
    assert.equal(String(p.headers.cookie).includes('account-secret'), false);
  }
});

test('health: persisted session works after restart and refreshes once on HTTP 401', async () => {
  const f = fixture({ session: JSON.stringify(token), expired: true });
  const result = await f.service.call('query', { metric: 'steps' }, owner);
  assert.equal(result.data.steps[0].steps, 1234);
  assert.equal(f.calls.filter(p => new URL(p.url).pathname === '/pass/serviceLogin').length, 1);
  assert.match(f.calls.find(p => new URL(p.url).pathname === '/pass/serviceLogin').headers.cookie, /passToken=account-secret/);
  const fresh = createHealthService(f.callHost, () => NOW);
  assert.equal((await fresh.call('query', { metric: 'steps' }, owner)).ok, true);
  await fresh.call('login', { action: 'logout' }, consoleContext);
  assert.equal(f.values.session, '');
  await assert.rejects(fresh.call('query', {}, owner), /扫码/);
});

test('health: credentials may be split between polling cookies, STS redirect query and STS cookies', async () => {
  for (const source of ['poll-cookie', 'sts-cookie', 'sts-query']) {
    const f = fixture();
    const service = createHealthService(async (method, params) => {
      if (method !== 'cap.http.request') return f.callHost(method, params);
      const r = await f.http(params);
      const url = new URL(params.url);
      if (url.pathname === '/poll') {
        const data = JSON.parse(r.body.replace('&&&START&&&', ''));
        delete data.cUserId;
        r.body = JSON.stringify(data);
        if (source === 'poll-cookie') r.setCookies = ['cUserId=c-user; Domain=.account.xiaomi.com; Secure'];
      }
      if (url.pathname === '/ticket') {
        r.setCookies = [];
        r.location += '?serviceToken=health-secret';
        if (source === 'sts-query') r.location += '&cUserId=c-user';
        if (source === 'sts-cookie') r.setCookies = ['cUserId=c-user; Path=/; Secure'];
      }
      return r;
    }, () => NOW);
    await service.call('login', { action: 'start' }, consoleContext);
    assert.equal((await service.call('login', { action: 'poll' }, consoleContext)).state, 'done', source);
    assert.equal(JSON.parse(f.values.session).c_user_id, 'c-user');
    assert.equal((await service.call('query', { metric: 'steps' }, owner)).data.steps[0].steps, 1234);
  }
});

test('health: incomplete login names missing fields without leaking secrets or replacing working session', async () => {
  const f = fixture({ session: JSON.stringify(token) });
  const original = f.values.session;
  const service = createHealthService(async (method, params) => {
    const r = await f.callHost(method, params);
    if (method === 'cap.http.request' && new URL(params.url).pathname === '/poll') {
      const data = JSON.parse(r.body.replace('&&&START&&&', ''));
      delete data.cUserId;
      r.body = JSON.stringify(data);
    }
    return r;
  }, () => NOW);
  await service.call('login', { action: 'start' }, consoleContext);
  await assert.rejects(service.call('login', { action: 'poll' }, consoleContext), error => {
    assert.match(error.message, /加密用户标识/);
    assert.equal(error.message.includes('health-secret'), false);
    return true;
  });
  assert.equal(f.values.session, original);
});

test('health: upstream first account-domain callback supplies serviceToken, consumed before redirect', async () => {
  const f = fixture();
  const service = createHealthService(async (method, params) => {
    if (method !== 'cap.http.request') return f.callHost(method, params);
    const url = new URL(params.url);
    if (url.pathname === '/account-callback') return { status: 302,
      location: 'https://account.xiaomi.com/end', setCookies: ['serviceToken=health-secret; Secure'] };
    const r = await f.http(params);
    if (url.pathname === '/poll') {
      const d = JSON.parse(r.body.replace('&&&START&&&', ''));
      d.location = 'https://c3.account.xiaomi.com/account-callback';
      r.body = JSON.stringify(d);
    }
    return r;
  }, () => NOW);
  await service.call('login', { action: 'start' }, consoleContext);
  assert.equal((await service.call('login', { action: 'poll' }, consoleContext)).state, 'done');
  assert.equal(JSON.parse(f.values.session).service_token, 'health-secret');
});

test('health: QR expiry, hostile auth URLs, truncated responses and repeated 401 fail closed', async () => {
  assert.equal(trustedUrl('https://c3.account.xiaomi.com/longPolling/login').hostname, 'c3.account.xiaomi.com');
  assert.equal(trustedUrl('https://c3.lp.account.xiaomi.com/lp/s').hostname, 'c3.lp.account.xiaomi.com');
  for (const url of ['http://account.xiaomi.com/x', 'https://account.xiaomi.com.evil.test/',
    'https://evilaccount.xiaomi.com/', 'https://account.xiaomi.com@evil.test/',
    'https://u:p@account.xiaomi.com/', 'https://127.0.0.1/', 'https://account.xiaomi.com:444/']) {
    assert.throws(() => trustedUrl(url));
  }
  const f = fixture();
  let time = NOW;
  const c = new XiaomiClient(f.http, async () => {}, () => time);
  await c.start();
  time += 301000;
  await assert.rejects(c.poll(), /过期/);
  const bad = new XiaomiClient(async () => ({ status: 200, body: '{}', truncated: true }), async () => {});
  await assert.rejects(bad.start(), /过大/);
  const unauthorized = fixture({ session: JSON.stringify(token) });
  const broken = createHealthService(async (method, params) => {
    if (method === 'cap.http.request' && params.url.includes('get_aggregated')) return { status: 401 };
    return unauthorized.callHost(method, params);
  }, () => NOW);
  await assert.rejects(broken.call('query', {}, owner), /401/);
  assert.equal(unauthorized.calls.filter(p => p.url.includes('/pass/serviceLogin')).length, 1);
});

test('health: missing values stay null, unrecognized fields never reach model; RC4 vector', () => {
  assert.deepEqual(normalizeMetric({ value: '{bad' }, 'steps'), {
    time: null, updatedAt: null, steps: null, distance: null, calories: null, goal: null });
  assert.equal(normalizeMetric({ value: { steps: 0 } }, 'steps').steps, 0);
  assert.equal(Buffer.from(rc4(Buffer.from('Key'), Buffer.from('Plaintext'), 0)).toString('hex'), 'bbf316e8d940af0ad3');
});

test('health: real host loads sandboxed plugin, encrypts session and rejects model-supplied console channel', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-health-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.resolve('examples/plugins/xiaomi-health');
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, parsed.error);
  const f = fixture({ now: Date.now() });
  const caps = createCapabilities({ pluginId: 'xiaomi-health', dataDir, manifest: parsed.manifest,
    getSettings: () => ({ acceptUnofficial: true, allowAgentRead: true }),
    getSender: () => ({ sendTextBatch: async () => {} }) });
  caps.methods['cap.http.request'] = f.http;
  const host = new PluginHost({ manifest: parsed.manifest, dataDir, capabilities: caps, log: () => {} });
  t.after(() => host.stop());
  assert.equal(await host.start(), true, host.lastError);
  await assert.rejects(host.callTool('login', { action: 'start', channel: 'console' }, { context: owner }));
  const start = await host.callTool('login', { action: 'start' }, { context: consoleContext }).catch(e => { throw new Error('start: ' + e.message); });
  assert.equal(start.ok, true);
  assert.equal((await host.callTool('login', { action: 'poll' }, { context: consoleContext }).catch(e => { throw new Error('poll: ' + e.message); })).state, 'done');
  const file = fs.readFileSync(path.join(dataDir, 'plugin-secrets', 'xiaomi-health.json'), 'utf8');
  assert.equal(file.includes('health-secret'), false);
  assert.equal(file.includes('account-secret'), false);
  await host.stop();
  assert.equal(await host.start(), true, host.lastError);
  assert.equal((await host.callTool('query', { metric: 'steps' }, { context: owner })).data.steps[0].steps, 1234);
  await host.stop();
  assert.equal(fs.existsSync(path.join(dataDir, 'plugin-secrets', 'xiaomi-health.json')), true);
});
