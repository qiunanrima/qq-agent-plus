import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wechat-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { AgentWechatChannel, wechatChatKey } = await import('../src/agent-wechat/runtime.js');
const { readWechatImages } = await import('../src/agent-wechat/media.js');
const { normalizeWechatConfig } = await import('../src/agent-wechat/config.js');
const { handleWechatAdminCommand } = await import('../src/agent-wechat/routes.js');
const { canRun, chatAllowed } = await import('../src/core/access.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { ChatStore } = await import('../src/core/store.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { COMMON_CHAT_TOOLS } = await import('../src/channels/tool-policy.js');
const { buildToolDefs } = await import('../src/tools/tools.js');
const { registerChatRoutes } = await import('../src/console/routes/chats.js');
const { SendQueue } = await import('../src/onebot/sender.js');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active'; cfg.allow.private = ['12345']; cfg.allowAllWhenEmpty = false;
  cfg.agentWechat = normalizeWechatConfig({ endpoint: 'http://127.0.0.1:6174', accountId: 'test', tokenFile: '/private/test-token', allow: ['wxid_test'], ...overrides });
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const calls = [], incoming = [];
  const api = { request: async (...args) => { calls.push(args); return { state: 'accepted', destination: 'wxid_test', serverId: '99' }; } };
  const runner = { controllers: new Map(), onIncoming: (...a) => incoming.push(a) };
  const runtime = new AgentWechatChannel({ dataDir: dir, getConfig: () => cfg, store, orchestrator: runner, api });
  if (cfg.agentWechat.enabled) runtime.attach();
  t.after(async () => { await runtime.dispose(); store.close(); });
  return { dir, cfg, store, calls, incoming, api, runner, runtime, key: wechatChatKey('test', 'wxid_test') };
}
const event = (overrides = {}) => ({ kind: 'message.committed', createdAt: new Date().toISOString(),
  data: { origin: 'live', direction: 'incoming', threadId: 'wxid_test', messageId: 'msg-1' }, ...overrides });
const message = { threadId: 'wxid_test', senderId: 'wxid_test', direction: 'incoming', type: 1, body: '你好' };

test('default disabled creates no files, timers or network; QQ policy unchanged', async t => {
  const f = fixture(t); await f.runtime.sync();
  assert.equal(fs.existsSync(path.join(f.dir, 'agent-wechat')), false);
  assert.equal(f.calls.length, 0); assert.equal(f.runtime.controller, null);
  assert.equal(chatAllowed('private:12345'), true); assert.equal(chatAllowed('private:55555'), false);
  assert.equal(canRun(f.key), false);
});
test('independent whitelist allows unbound wxid without allowing other QQ or WeChat users', async t => {
  const f = fixture(t, { enabled: true });
  assert.equal(canRun(f.key), true); assert.equal(f.runtime.linkedQq(f.key), '');
  assert.equal(canRun(wechatChatKey('test', 'wxid_other')), false);
  assert.equal(canRun(wechatChatKey('other-account', 'wxid_test')), false);
  assert.equal(canRun('private:55555'), false);
  f.cfg.agentWechat.allow = []; assert.equal(canRun(f.key), false);
});
test('only fresh live direct text enters the existing store and orchestrator; replay is deduplicated', async t => {
  const f = fixture(t, { enabled: true }); f.api.request = async () => message;
  await f.runtime.receive(event(), new AbortController().signal);
  await f.runtime.receive(event(), new AbortController().signal);
  assert.equal(f.incoming.length, 1); assert.equal(f.store.recent(f.key)[0].text, '你好');
  for (const e of [event({ createdAt: 'invalid' }), event({ createdAt: new Date(0).toISOString() }),
    event({ data: { ...event().data, origin: 'catch_up' } }), event({ data: { ...event().data, threadId: 'x@chatroom' } }),
    event({ data: { ...event().data, direction: 'outgoing' } })]) await f.runtime.receive(e, new AbortController().signal);
  assert.equal(f.incoming.length, 1);
});
test('mismatched message body cannot redirect the incoming conversation', async t => {
  const f = fixture(t, { enabled: true }); f.api.request = async () => ({ ...message, threadId: 'wxid_other' });
  await f.runtime.receive(event(), new AbortController().signal); assert.equal(f.incoming.length, 0);
});

test('WeChat images and stickers enter shared history without storing source XML or URLs', async t => {
  const f = fixture(t, { enabled: true });
  for (const type of [3, 47]) {
    f.api.request = async () => ({ ...message, type, body: '<private-cdn-credentials>' });
    await f.runtime.receive(event({ data: { ...event().data, messageId: `image-${type}` } }), new AbortController().signal);
  }
  const rows = f.store.recent(f.key);
  assert.deepEqual(rows.map(r => r.text), ['[图片]', '[表情包]']);
  assert.ok(rows.every(r => r.media[0].channel === 'wechat' && !r.media[0].url));
  assert.equal(f.incoming.length, 2);
});

test('WeChat lookups return actual image input and never fetch other chats or untrusted content URLs', async t => {
  const f = fixture(t, { enabled: true });
  f.store.appendIncoming(f.key, { mid: 'image-3', text: '[图片]', media: [{ kind: 'image', channel: 'wechat' }] });
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex'); const seen = [];
  f.api.request = async route => {
    seen.push(route);
    if (route === '/messages/image-3') return { ...message, type: 3 };
    if (route === '/messages/image-3/media') return { items: [{ id: 'asset_test', accountId: 'test', messageId: 'image-3',
      state: 'available', variant: 'standard', contentUrl: 'http://attacker.invalid/secret' }] };
    if (route === '/media/asset_test/content') return bytes;
    throw Error('Unexpected route');
  };
  const result = await readWechatImages(f.runtime, f.key, {}, { messageId: 'image-3' });
  assert.equal(result.isError, false);
  assert.equal(result.content[1].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.deepEqual(seen, ['/messages/image-3', '/messages/image-3/media', '/media/asset_test/content']);
  seen.length = 0;
  const wrong = await readWechatImages(f.runtime, f.key, {}, { messageId: 'other-chat-image' });
  assert.equal(wrong.isError, true); assert.equal(seen.length, 0);
  f.api.request = async route => route.endsWith('/media') ? { items: [{ accountId: 'other-account', messageId: 'image-3' }] } : { ...message, type: 3 };
  assert.equal((await readWechatImages(f.runtime, f.key, {}, { messageId: 'image-3' })).isError, true);
});

test('unsupported WeChat sticker source is reported as unseen without falling back to OneBot', async t => {
  const f = fixture(t, { enabled: true });
  f.store.appendIncoming(f.key, { mid: 'sticker', text: '[表情包]', media: [{ kind: 'image', channel: 'wechat' }] });
  f.api.request = async route => { if (route.endsWith('/media')) throw Error('sticker_source_not_allowed'); return { ...message, type: 47 }; };
  const result = await readWechatImages(f.runtime, f.key, {}, { messageId: 'sticker' });
  assert.equal(result.isError, true); assert.ok(result.content.every(p => p.type === 'text'));
  assert.match(result.content[0].text, /不要声称已看见/);
});

test('uncached WeChat image polls one scoped download job and a lost submit is not automatically repeated', async t => {
  const f = fixture(t, { enabled: true });
  f.store.appendIncoming(f.key, { mid: 'uncached', text: '[图片]', media: [{ kind: 'image', channel: 'wechat' }] });
  let submissions = 0, lookups = 0, polls = 0;
  f.api.request = async route => {
    if (route === '/messages/uncached') return { ...message, type: 3 };
    if (route.endsWith('/media')) return { items: ++lookups > 2 ? [{ id: 'asset_test', accountId: 'test', messageId: 'uncached', state: 'available' }] : [] };
    if (route.endsWith('/media-transfers')) { submissions++; return { id: 'download', kind: 'download', accountId: 'test', state: 'queued' }; }
    if (route === '/jobs/download') { polls++; return { id: 'download', kind: 'download', accountId: 'test', state: 'completed' }; }
    if (route === '/media/asset_test/content') return Buffer.from('89504e470d0a1a0a', 'hex');
    throw Error('Unexpected route');
  };
  assert.equal((await readWechatImages(f.runtime, f.key, {}, { messageId: 'uncached' })).isError, false);
  assert.equal(submissions, 1); assert.equal(polls, 1);
  lookups = -100;
  f.api.request = async route => {
    if (route === '/messages/uncached') return { ...message, type: 3 };
    if (route.endsWith('/media')) return { items: [] };
    submissions++; throw Error('connection lost');
  };
  assert.equal((await readWechatImages(f.runtime, f.key, {}, { messageId: 'uncached' })).isError, true);
  assert.equal((await readWechatImages(f.runtime, f.key, {}, { messageId: 'uncached' })).isError, true);
  assert.equal(submissions, 2, 'the uncertain second download must not be submitted again');
});
test('private/all history sharing never crosses QQ and WeChat or two wxids', t => {
  const f = fixture(t);
  for (const [key, text] of [['private:12345', 'QQ only'], [f.key, 'WeChat only'], [wechatChatKey('test', 'wxid_other'), 'other DM']])
    f.store.appendIncoming(key, { mid: text, text, senderId: 'test' });
  assert.deepEqual(f.store.recent('private:12345', { scope: 'private' }).map(m => m.text), ['QQ only']);
  assert.deepEqual(f.store.recent('private:12345', { scope: 'all' }).map(m => m.text), ['QQ only']);
  assert.deepEqual(f.store.recent(f.key, { scope: 'private' }).map(m => m.text), ['WeChat only']);
});
test('binding selects only linked QQ person; unbound uses wxid and never inherits administrator status', t => {
  const f = fixture(t, { enabled: true, bindings: { wxid_test: '12345' } });
  const seen = []; const memory = { formatForPrompt: (...a) => { seen.push(a); return 'person'; } };
  assert.equal(f.runtime.memoryFor(f.key, memory).formatForPrompt('ignored'), 'person');
  assert.deepEqual(seen[0], ['private:12345', { userIds: ['12345'] }]);
  delete f.cfg.agentWechat.bindings.wxid_test;
  f.runtime.memoryFor(f.key, memory).formatForPrompt('ignored');
  assert.deepEqual(seen[1], [f.key, { userIds: ['wxid_test'] }]);
});
test('accepted WeChat send uses durable existing outbox and never OneBot', async t => {
  const f = fixture(t, { enabled: true });
  const sender = new SendQueue({ onebot: new Proxy({}, { get: () => () => { throw Error('QQ transport must not be used'); } }), store: f.store });
  const result = await sender.sendTextBatch(f.key, ['hello'], { runId: 'wx-run' });
  assert.equal(result.sent.length, 1); assert.equal(f.calls[0][0], '/sends');
  assert.equal(f.calls[0][1].body.threadId, 'wxid_test'); assert.ok(f.calls[0][1].key);
  assert.equal(f.store.hasUncertainEffects('wx-run'), false);
});
test('queued and submitting are polled to acceptance without resubmitting either bubble', async t => {
  const f = fixture(t, { enabled: true });
  const polls = new Map(); let submissions = 0;
  f.api.request = async (route, options = {}) => {
    if (route === '/sends') {
      submissions++;
      assert.ok(options.key);
      return { id: `send-${submissions}`, state: 'queued' };
    }
    const count = (polls.get(route) || 0) + 1; polls.set(route, count);
    assert.equal(options.body, undefined);
    return count === 1 ? { id: route.split('/').at(-1), state: 'submitting' }
      : { state: 'accepted', destination: 'wxid_test', serverId: String(100 + submissions) };
  };
  const result = await f.runtime.sendTextBatch(f.key, ['first', 'second'], { runId: 'submitting' });
  assert.equal(result.sent.length, 2);
  assert.equal(submissions, 2, 'each bubble must be submitted once');
  assert.deepEqual([...polls.values()], [2, 2]);
  assert.equal(f.store.hasUncertainEffects('submitting'), false);
});

test('console test-send without a model run ID uses a nullable outbox run', async t => {
  const f = fixture(t, { enabled: true });
  const sender = new SendQueue({ onebot: {}, store: f.store });
  const result = await sender.sendTextBatch(f.key, ['console test']);
  assert.equal(result.sent.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.db.prepare('SELECT run_id FROM outbox').get().run_id, null);
});

test('unknown send blocks any additional submission and is never retried', async t => {
  const f = fixture(t, { enabled: true }); let submissions = 0;
  f.api.request = async () => { submissions++; throw Error('connection reset'); };
  await assert.rejects(f.runtime.sendTextBatch(f.key, ['hello'], { runId: 'uncertain' }), /Delivery uncertain/);
  await assert.rejects(f.runtime.sendTextBatch(f.key, ['hello again'], { runId: 'uncertain' }), /Delivery uncertain/);
  assert.equal(submissions, 1); assert.equal(f.store.hasUncertainEffects('uncertain'), true);
});
test('stopping WeChat cancels only WeChat controllers, preserving QQ requests', async t => {
  const f = fixture(t, { enabled: true }); const qq = new AbortController(), wx = new AbortController();
  f.runner.controllers.set('private:12345', qq); f.runner.controllers.set(f.key, wx);
  f.cfg.agentWechat.allow = []; await f.runtime.stop();
  assert.equal(wx.signal.aborted, true); assert.equal(qq.signal.aborted, false);
});
test('QQ owner commands bind and unbind without adding to WeChat whitelist; forwarded or non-owner commands denied', async t => {
  const f = fixture(t); f.cfg.admin.ownerUin = '12345'; const replies = [];
  const deps = { getConfig: () => f.cfg, updateConfig: patch => { f.cfg.agentWechat = patch.agentWechat.__replace__; },
    runtime: { stop: async () => {}, sync: async () => {} }, audit: async () => true, reply: async (...a) => replies.push(a) };
  const command = text => ({ post_type: 'message', message_type: 'private', self_id: '88888', user_id: '12345', raw_message: text });
  assert.equal(await handleWechatAdminCommand(command('绑定微信 wxid_other 54321'), deps), true);
  assert.equal(f.cfg.agentWechat.bindings.wxid_other, '54321'); assert.deepEqual(f.cfg.agentWechat.allow, ['wxid_test']);
  await handleWechatAdminCommand(command('解绑微信 wxid_other'), deps); assert.equal(Object.hasOwn(f.cfg.agentWechat.bindings, 'wxid_other'), false);
  assert.equal(await handleWechatAdminCommand({ ...command('绑定微信 wxid_test 54321'), user_id: '54321' }, deps), false);
  assert.equal(await handleWechatAdminCommand({ ...command('绑定微信 wxid_test 54321'), post_type: 'message_sent' }, deps), false);
  assert.equal(replies.length, 2);
});
test('invalid endpoint, group whitelist and invalid identity fail closed', () => {
  assert.throws(() => normalizeWechatConfig({ endpoint: 'http://example.com' }));
  assert.throws(() => normalizeWechatConfig({ allow: ['123@chatroom'] }));
  assert.throws(() => normalizeWechatConfig({ bindings: { wxid_test: 'not-qq' } }));
});

test('binding reads only the linked identity from hippocampus-inclusive views', t => {
  const f = fixture(t, { bindings: { wxid_test: '12345' } });
  const memory = { query: () => ({ memberImpression: [{ userId: '12345', content: '喜欢茶', origin: 'hippocampus' },
    { userId: '67890', content: '其他人的资料' }] }) };
  const text = f.runtime.memoryFor(f.key, memory).formatIndexForPrompt();
  assert.ok(text.includes('喜欢茶')); assert.ok(!text.includes('其他人的资料'));
});

test('common tools are aligned while QQ-only writes stay absent; person queries remain identity-bound', async t => {
  const f = fixture(t, { enabled: true, bindings: { wxid_test: '12345' } });
  const memory = { query: () => ({ memberImpression: [{ userId: '12345', content: '喜欢茶' }, { userId: '67890', content: '其他人的记忆' }] }) };
  const defs = f.runtime.toolsFor(f.key, buildToolDefs(), { memory, persona: {} });
  for (const name of ['get_recent_messages', 'get_message_detail', 'memory_query', 'search_web', 'fetch_url']) assert.ok(defs.some(d => d.name === name), name);
  for (const name of ['send_poke', 'send_voice', 'kick_group_member', 'send_sticker']) assert.ok(!defs.some(d => d.name === name), name);
  const query = defs.find(d => d.name === 'memory_query');
  const result = await query.execute({}, { userId: '12345' });
  assert.ok(result.content.includes('喜欢茶')); assert.ok(!result.content.includes('其他人的记忆'));
  assert.equal((await query.execute({}, { userId: '67890' })).isError, true);
  f.cfg.agentWechat.bindings = {};
  assert.equal((await query.execute({}, { userId: '12345' })).isError, true);
});

test('console routes reuse shared DM handlers for WeChat without accepting fake group or QQ IDs', async () => {
  const routes = [], awakened = [];
  const router = { add: (method, pattern, handler) => routes.push({ method, pattern, handler }) };
  const noop = () => {};
  registerChatRoutes(router, { json: (_res, status, body) => ({ status, body }), readBody: async () => ({}), emit: noop, log: noop,
    store: {}, orchestrator: { requestManualWake: key => { awakened.push(key); return { ok: true }; } }, sender: {}, onebot: {},
    updateConfig: noop, groupDigest: {}, adminBriefing: {}, getIncidentPilot: noop, getSlangPilot: noop });
  const id = `wechat_${'a'.repeat(64)}`;
  const match = url => routes.filter(r => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test(url));
  const wx = match(`/api/chats/private_${id}/wake`);
  assert.equal(wx.length, 1);
  assert.equal((await wx[0].handler({}, {}, wx[0].pattern.exec(`/api/chats/private_${id}/wake`))).status, 202);
  assert.deepEqual(awakened, [`private:${id}`]);
  assert.equal(match(`/api/chats/group_${id}/wake`).length, 0);
  assert.equal(match('/api/chats/private_fakeQQ/wake').length, 0);
  assert.equal(match('/api/chats/private_12345/wake').length, 1);
});

test('first activation skips old events and a saved cursor survives adapter restart', async t => {
  const f = fixture(t, { enabled: true });
  f.api.request = async route => route === '' ? { authenticated: true, connection: 'online' } : { items: [event()], nextCursor: '73' };
  await f.runtime.sync();
  for (let n = 0; n < 30 && !fs.existsSync(f.runtime.file); n++) await new Promise(r => setTimeout(r, 10));
  await f.runtime.stop();
  assert.equal(f.incoming.length, 0); assert.equal(f.runtime.read().accounts['http://127.0.0.1:6174:test'].cursor, '73');
  f.runtime.state = null;
  assert.equal(f.runtime.read().accounts['http://127.0.0.1:6174:test'].initialized, true);
});

test('WeChat protocol failure remains local and cannot cancel a QQ controller', async t => {
  const f = fixture(t, { enabled: true }); const qq = new AbortController();
  f.runner.controllers.set('private:12345', qq); f.api.request = async () => { throw Error('protocol offline'); };
  await f.runtime.sync();
  for (let n = 0; n < 30 && !f.runtime.error; n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(f.runtime.error); assert.equal(qq.signal.aborted, false); assert.equal(canRun('private:12345'), true);
  await f.runtime.stop(); assert.equal(qq.signal.aborted, false);
});

test('real shared Agent handles WeChat then QQ with their own tool catalogs and send routes', async t => {
  const f = fixture(t, { enabled: true, bindings: { wxid_test: '12345' } });
  f.cfg.api.model = 'mock'; f.cfg.api.baseUrl = 'https://model.invalid'; f.cfg.api.maxRounds = 3;
  f.cfg.humanize.enabled = false; f.cfg.sticker.enabled = false; f.cfg.memory.consolidateEnabled = false;
  f.cfg.webSearch.enabled = false; f.cfg.conversation.replyGuardEnabled = false;
  setRuntimeConfig(f.cfg);
  const sessions = new SessionRegistry(); const qqSent = [], requests = [];
  const actualSender = new SendQueue({ onebot: {}, store: f.store });
  const sender = { sendTextBatch: (key, texts, options) => key === f.key ? actualSender.sendTextBatch(key, texts, options)
    : Promise.resolve({ sent: texts.map(text => { qqSent.push(text); return { text, messageId: 'qq-id' }; }), failed: [] }) };
  const memory = { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null };
  const runner = new Orchestrator({ store: f.store, sessions, memory, stickers: {}, sender, onebot: { selfId: '88888', selfNickname: 'bot' } });
  f.runtime.orchestrator = runner;
  const original = globalThis.fetch; let round = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body)); round++;
    const name = round % 2 ? 'send_message' : 'finish';
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `call-${round}`, type: 'function', function: { name,
      arguments: JSON.stringify(name === 'finish' ? { summary: '已回复' } : { messages: ['你好呀'] }) } }] } }], usage: { total_tokens: 10 } });
  };
  t.after(async () => { globalThis.fetch = original; await runner.abortAll(); });
  f.store.appendIncoming(f.key, { mid: 'wx-turn', text: '你好', senderId: 'wxid_test' });
  await runner.wake(f.key);
  const first = sessions.listSummaries(10)[0]; assert.equal(sessions.get(first.id).status, 'done', JSON.stringify(sessions.get(first.id)));
  assert.ok(requests[0].messages[0].content.includes('微信私聊'));
  assert.ok(requests[0].tools.every(tool => COMMON_CHAT_TOOLS.has(tool.function.name)));
  assert.equal(f.calls.filter(([p]) => p === '/sends').length, 1); assert.equal(qqSent.length, 0);
  f.store.appendIncoming('private:12345', { mid: 'qq-turn', text: '你好', senderId: '12345' });
  await runner.wake('private:12345'); assert.deepEqual(qqSent, ['你好呀']); assert.equal(requests.length, 4);
});
