import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash } from 'node:crypto';
import { WeixinApi, officialBase, parseWire, conversationKey } from '../src/weixin/protocol.js';
import { WeixinRuntime } from '../src/weixin/runtime.js';
import { WeixinStore } from '../src/weixin/store.js';
import { normalizeWeixinConfig } from '../src/weixin/config.js';
import { impressionVisible } from '../src/core/memory-visibility.js';

async function setup(t, model) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-test-'));
  const config = { weixin: { enabled: true }, antigravityCli: { nativeApproval: true, qqApproval: false } };
  const sends = [], reads = [], appended = [];
  const store = new WeixinStore(dir), account = { id: 'bot', owner: 'alice', token: 'secret', base: 'https://ilinkai.weixin.qq.com' };
  store.resetAccount(account);
  const key = createHash('sha256').update('bot:alice').digest('hex');
  store.read().peers[key] = { userId: 'alice', accountId: 'bot', enabled: true, nativeApproval: false, history: [] };
  const runtime = new WeixinRuntime({ dataDir: dir, getConfig: () => config, store, model,
    persona: () => '共享角色', readPerson: id => { reads.push(id); return { impressions: [{ content: '喜欢猫', sourceChatKeys: ['private:123'] }] }; },
    appendPerson: (...args) => appended.push(args), api: {
      request: async (endpoint, options) => { sends.push({ endpoint, ...options.body }); return { ret: 0 }; },
      image: async () => ({ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' })
    } });
  t.after(async () => { await runtime.stop(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const message = (id = '9007199254740993', from = 'alice') => ({ from_user_id: from, message_id: id, create_time_ms: Date.now(), message_type: 1,
    context_token: 'context-secret', item_list: [{ type: 1, text_item: { text: '喜欢猫' } }] });
  return { runtime, config, sends, store, account, key, reads, appended, message };
}

test('微信协议保留 uint64，限制官方主机，认证和游标正确且不会重试发送', async () => {
  assert.equal(parseWire('{"message_id":18446744073709551615,"message_type":1}').message_id, '18446744073709551615');
  for (const base of ['http://ilinkai.weixin.qq.com', 'https://evil.test', 'https://ilinkai.weixin.qq.com.evil.test', 'https://u:p@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/a']) assert.throws(() => officialBase(base));
  let calls = 0;
  const api = new WeixinApi({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
    assert.equal(options.headers.Authorization, 'Bearer private-token'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.get_updates_buf, 'cursor'); assert.equal(body.base_info.bot_agent, 'QQAgentPlus/0.9.14');
    return new Response('{"ret":-14}');
  } });
  await assert.rejects(api.request('getupdates', { account: { token: 'private-token' }, body: { get_updates_buf: 'cursor' } }), { code: -14 });
  assert.equal(calls, 1);
  assert.notEqual(conversationKey('a', 'same'), conversationKey('b', 'same'));
  assert.throws(() => normalizeWeixinConfig({ enabled: 'true' }));
  assert.deepEqual(normalizeWeixinConfig({ graduated: true }), { enabled: false, graduated: true });
});

test('图片只从官方 CDN 获取，兼容原始和十六进制 base64 密钥', async () => {
  const key = Buffer.alloc(16, 7), png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  const api = new WeixinApi({ fetchImpl: async url => { assert.equal(new URL(url).hostname, 'novac2c.cdn.weixin.qq.com'); return new Response(encrypted); } });
  for (const encoded of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')]) {
    const result = await api.image({ image_item: { media: { aes_key: encoded, encrypt_query_param: 'x' } } }, new AbortController().signal);
    assert.equal(result.mimeType, 'image/png'); assert.equal(result.data, png.toString('base64'));
  }
  await assert.rejects(api.image({ image_item: { media: { aes_key: key.toString('base64'), full_url: 'https://evil.test/image' } } }, new AbortController().signal), /官方 CDN/);
});

test('从未启用的微信模块不创建目录；状态不泄露凭据与上下文令牌', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weixin-lazy-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = new WeixinRuntime({ dataDir: dir, getConfig: () => ({ weixin: { enabled: false } }) });
  runtime.start(); assert.equal(runtime.status().running, false); assert.deepEqual(await fs.readdir(dir), []);
  await runtime.stop();
});

test('MCP 发送绑定微信收件人，重复消息不重发，未绑定不读 QQ 记忆', async t => {
  let count = 0;
  const env = await setup(t, async ({ mcpRun }) => {
    count++; assert.equal(mcpRun.platform, 'weixin'); assert.equal(mcpRun.imageOnlyAcp, true); assert.equal(mcpRun.approvalAllowed('native'), false);
    assert.equal((await mcpRun.execute('memory_append', { content: '不允许' })).isError, true);
    await mcpRun.execute('send_message', { Arguments: { messages: ['你好'], to_user_id: 'bob' }, ServerName: 'qq_run', ToolName: 'qq_send_message' });
    await mcpRun.execute('finish', { summary: '打了招呼' });
    assert.equal((await mcpRun.execute('send_message', { messages: ['重复'] })).isError, true);
    return { toolsExecutedViaMcp: true, message: { role: 'assistant', content: '' } };
  });
  const message = env.message();
  await env.runtime.receive(message, env.account, new AbortController().signal);
  await env.runtime.receive(message, env.account, new AbortController().signal);
  assert.equal(count, 1); assert.deepEqual(env.reads, []); assert.equal(env.sends.length, 1);
  assert.equal(env.sends[0].msg.to_user_id, 'alice'); assert.equal(env.sends[0].msg.context_token, 'context-secret');
  assert.equal(env.store.read().peers[env.key].summary, '打了招呼');
  assert.deepEqual(env.store.read().peers[env.key].history.map(row => row.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(env.runtime.status()), /context-secret|"secret"/);
});

test('显式绑定才共享本人记忆并保存微信来源；其他联系人默认拒绝、群聊和过期消息不触发模型', async t => {
  const env = await setup(t, async ({ messages, mcpRun }) => {
    assert.match(messages[0].content, /喜欢猫/);
    await mcpRun.execute('memory_append', { content: '喜欢猫' });
    await mcpRun.execute('finish', { summary: '记住个人偏好' });
    return { toolsExecutedViaMcp: true, message: { role: 'assistant', content: '' } };
  });
  env.store.read().peers[env.key].qqId = '123';
  const signal = new AbortController().signal;
  await env.runtime.receive(env.message(), env.account, signal);
  await env.runtime.receive(env.message('2', 'bob'), env.account, signal);
  await env.runtime.receive({ ...env.message('3'), group_id: 'group' }, env.account, signal);
  await env.runtime.receive({ ...env.message('4'), create_time_ms: 1 }, env.account, signal);
  assert.deepEqual(env.reads, ['123']); assert.equal(env.appended.length, 1);
  assert.equal(env.appended[0][0], conversationKey('bot', 'alice')); assert.equal(env.appended[0][1], '123');
  assert.equal(impressionVisible({ sourceChatKeys: [env.appended[0][0]] }, 'group:1', { hidePrivateInGroup: true }), false);
});

test('未知发送持久留痕，重启后重复入站不自动重试', async t => {
  const env = await setup(t, async ({ mcpRun }) => {
    await mcpRun.execute('send_message', { messages: ['可能已发送'] });
    throw new Error('must not reach');
  });
  let attempts = 0;
  env.runtime.api.request = async () => { attempts++; throw new Error('connection lost'); };
  const message = env.message();
  await env.runtime.receive(message, env.account, new AbortController().signal);
  assert.equal(env.store.read().outbox[0].state, 'unknown'); assert.equal(env.store.read().runs[0].status, 'error');
  env.runtime.store = new WeixinStore(path.dirname(path.dirname(env.store.file)));
  await env.runtime.receive(message, env.runtime.store.read().account, new AbortController().signal);
  assert.equal(attempts, 1); assert.equal(env.runtime.status().unknownSends, 1);
  env.runtime.resolveSend(env.runtime.store.read().outbox[0].id, false);
  assert.equal(env.runtime.status().unknownSends, 0); assert.equal(attempts, 1);
});

test('API 模式图像输入经工具注入，跨轮上下文仅保留当前微信聊天', async t => {
  let rounds = 0;
  const env = await setup(t, async ({ messages }) => {
    rounds++;
    if (rounds === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'image', type: 'function', function: { name: 'get_message_images', arguments: '{}' } }] } };
    assert.equal(messages.at(-1).content[0].type, 'image_url');
    return { message: { role: 'assistant', content: '看到图片了' } };
  });
  const message = env.message(); message.item_list.push({ type: 2, image_item: {} });
  await env.runtime.receive(message, env.account, new AbortController().signal);
  assert.equal(rounds, 2); assert.equal(env.sends.length, 1);
  assert.equal(env.store.read().peers[env.key].history.length, 2);
});

test('扫码登录状态不返回凭据，身份和原生权限独立且停用可中断收取', async t => {
  const env = await setup(t, async () => { throw new Error('No model call'); });
  env.config.weixin.enabled = false;
  env.runtime.api.request = async endpoint => endpoint.startsWith('get_bot_qrcode')
    ? { qrcode: 'qr', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/test' }
    : { status: 'confirmed', ilink_bot_id: 'bot', ilink_user_id: 'alice', bot_token: 'new-private-token', baseurl: 'https://ilinkai.weixin.qq.com' };
  const qr = await env.runtime.beginLogin(); assert.match(qr.qrcodeDataUrl, /^data:image\/png;base64,/);
  const result = await env.runtime.pollLogin(qr.id);
  assert.deepEqual(result, { status: 'confirmed' }); assert.doesNotMatch(JSON.stringify(env.runtime.status()), /new-private-token/);
  assert.equal(env.store.read().peers[env.key].nativeApproval, false);
  await env.runtime.configurePeer(env.key, { enabled: true, nativeApproval: false, qqId: '123' });
  assert.equal(env.store.read().peers[env.key].qqId, '123');
  await env.runtime.configurePeer(env.key, { enabled: true, nativeApproval: false, qqId: '' });
  assert.equal(env.store.read().peers[env.key].qqId, '');
  await assert.rejects(env.runtime.configurePeer(env.key, { enabled: true, nativeApproval: true, qqId: ['123'] }));
  let aborted = false;
  env.runtime.api.request = (_endpoint, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ msgs: [] }); }, { once: true }));
  env.config.weixin.enabled = true; env.runtime.start();
  env.config.weixin.enabled = false; await env.runtime.sync(); assert.equal(aborted, true);
  assert.equal(env.runtime.status().running, false);
});

test('图片读取失败作为工具错误反馈，模型可诚实回复而不重试下载', async t => {
  let rounds = 0, downloads = 0;
  const env = await setup(t, async ({ messages }) => {
    if (++rounds === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'image', type: 'function', function: { name: 'get_message_images', arguments: '{}' } }] } };
    assert.match(messages.at(-1).content, /没有看到图片/);
    return { message: { role: 'assistant', content: '这张图片暂时没能读取' } };
  });
  env.runtime.api.image = async () => { downloads++; throw new Error('decrypt failed'); };
  const message = env.message(); message.item_list = [{ type: 2, image_item: {} }];
  await env.runtime.receive(message, env.account, new AbortController().signal);
  assert.equal(downloads, 1); assert.equal(env.sends.length, 1);
});
