import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createInbox } from '../examples/plugins/bilibili-lite/inbox.mjs';
import { allowsUid, uidList } from '../examples/plugins/bilibili-lite/message-policy.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bilibili-inbox-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* handles */ } });
const { BilibiliChannel } = await import('../src/plugins/bilibili-channel.js');
const { ChatStore } = await import('../src/core/store.js');
const { chatAllowed } = await import('../src/core/access.js');

test('收发白名单各自独立，默认空名单拒绝，坏名单不可放行', () => {
  const s = { receiveUids: '7，8', sendUids: '9', receiveWhitelistEnabled: true, sendWhitelistEnabled: true };
  assert.deepEqual(uidList(s.receiveUids), ['7', '8']);
  assert.equal(allowsUid(s, 'receive', '7'), true);
  assert.equal(allowsUid(s, 'send', '7'), false);
  assert.equal(allowsUid(s, 'send', '9'), true);
  assert.equal(allowsUid({}, 'receive', '7'), false);
  assert.equal(allowsUid({ ...s, sendWhitelistEnabled: false }, 'send', '7'), true);
  assert.equal(allowsUid({ ...s, sendWhitelistEnabled: false }, 'receive', '9'), false);
  assert.throws(() => uidList('7, not-a-uid'), /白名单/);
});

test('收信基线、无损序号、过滤撤回/自身/旧消息，ACK后才提交游标；关闭收信不访问网络', async () => {
  let settings = { receiveEnabled: true, receiveUids: '7' };
  let saved = null, calls = 0, seq = '18446744073709551000';
  let time = Date.now();
  const messages = [];
  const inbox = createInbox({ getSettings: () => settings, now: () => time,
    navIdentity: async () => { calls += 1; return { isLogin: true, mid: '42' }; },
    callHost: async (method, params) => {
      if (method === 'cap.storage.get') return { value: saved };
      saved = structuredClone(params.value); return { ok: true };
    },
    httpJson: async url => {
      calls += 1;
      if (url.includes('get_sessions')) return { data: { session_list: [
        { talker_id: '7', session_type: 1, last_msg: { msg_seqno: seq } },
        { talker_id: '8', session_type: 1, last_msg: { msg_seqno: seq } }
      ] } };
      assert.ok(url.includes('talker_id=7'));
      return { data: { messages } };
    }
  });
  assert.equal((await inbox.poll()).events.length, 0);
  assert.equal(saved.cursors['7'], seq);
  const row = (n, overrides = {}) => ({ sender_uid: '7', msg_type: 1, msg_status: 0,
    timestamp: time / 1000, msg_seqno: String(BigInt(seq) + BigInt(n)), content: JSON.stringify({ content: `消息${n}` }), ...overrides });
  messages.push(row(1), row(2, { msg_status: 1 }), row(3, { sender_uid: '42' }), row(4, { timestamp: (time - 900000) / 1000 }));
  seq = messages.at(-1).msg_seqno;
  time += 60000;
  const batch = await inbox.poll();
  assert.deepEqual(batch.events.map(e => e.text), ['消息1']);
  assert.equal(saved.cursors['7'], '18446744073709551000');
  await assert.rejects(() => inbox.ack('made-up-token'), /无效/);
  await inbox.ack(batch.checkpoint);
  assert.equal(saved.cursors['7'], seq);
  time += 60000;
  assert.equal((await inbox.poll()).events.length, 0);
  settings = { ...settings, receiveEnabled: false };
  const before = calls;
  assert.equal((await inbox.poll()).events.length, 0);
  assert.equal(calls, before);
});

test('用户设置检查间隔：未到时间不请求接口，修改间隔即时按新值判断', async () => {
  let time = 1000000, calls = 0;
  const settings = { receiveEnabled: true, receiveWhitelistEnabled: false, pollIntervalMinutes: 5 };
  const inbox = createInbox({ getSettings: () => settings, now: () => time,
    navIdentity: async () => { calls += 1; return { isLogin: true, mid: '42' }; },
    callHost: async () => ({ value: { initialized: true, cursors: {} } }),
    httpJson: async () => ({ data: { session_list: [] } })
  });
  await inbox.poll(); assert.equal(calls, 1);
  time += 60000;
  await inbox.poll(); assert.equal(calls, 1);
  time += 240000;
  await inbox.poll(); assert.equal(calls, 2);
  time += 60000; settings.pollIntervalMinutes = 1;
  await inbox.poll(); assert.equal(calls, 3);
});

test('B站独立会话入库、去重和AI唤醒；白名单收发独立，禁止QQ共享历史与管理工具', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'channel-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  const cfg = { runtime: { mode: 'active', paused: false }, plugins: { enabled: true, enabledIds: ['bilibili-lite'],
    settings: { 'bilibili-lite': { receiveEnabled: true, receiveUids: '7', sendUids: '9' } }, switches: { 'bilibili-lite': { message_send: true } } } };
  const wakes = [], acks = [], sends = [];
  const registry = { hosts: new Map([['bilibili-lite', { state: 'running', callTool: async (...args) => { acks.push(args); } }]]),
    sendBilibiliMessage: async (...args) => { sends.push(args); return { content: JSON.stringify({ ok: true }) }; }
  };
  const adapter = new BilibiliChannel({ registry, store, getConfig: () => cfg,
    orchestrator: { controllers: new Map(), onIncoming: (...args) => wakes.push(args) } });
  adapter.start(); t.after(() => adapter.stop());
  const key = 'private:bilibili_42_7';
  const batch = { account: '42', checkpoint: 'token', events: [
    { mid: '7', seqno: '18446744073709551001', ts: Date.now(), text: '你好' },
    { mid: '8', seqno: '1', ts: Date.now(), text: '应丢弃' }
  ] };
  await adapter.receiveBatch('bilibili-lite', batch);
  await adapter.receiveBatch('bilibili-lite', batch);
  assert.equal(wakes.length, 1);
  assert.equal(acks.length, 2);
  assert.equal(wakes[0][0], key);
  assert.equal(wakes[0][1].senderId, 'bilibili_7');
  assert.equal(chatAllowed(key, cfg), true);
  store.appendIncoming('private:12345', { mid: 'qq-1', ts: Date.now(), senderId: '12345', text: 'QQ私密记录' });
  store.appendIncoming('private:bilibili_42_9', { mid: 'bili-9', ts: Date.now(), senderId: 'bilibili_9', text: '其他B站私信' });
  assert.deepEqual(store.recent(key, { scope: 'private' }).map(r => r.text), ['你好']);
  assert.deepEqual(store.recent('private:12345', { scope: 'all' }).map(r => r.text), ['QQ私密记录']);
  assert.deepEqual(adapter.toolsFor(key, ['send_message', 'finish', 'plugin_call', 'mcp_call', 'send_poke', 'get_recent_messages']
    .map(name => ({ name }))).map(d => d.name), ['send_message', 'finish', 'get_recent_messages']);
  await assert.rejects(() => adapter.sendTextBatch(key, ['不在发信名单']), /白名单/);
  cfg.plugins.settings['bilibili-lite'].sendUids = '7';
  assert.equal((await adapter.sendTextBatch(key, ['允许的回复'])).sent.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], '7');
  cfg.plugins.switches['bilibili-lite'].message_send = false;
  await assert.rejects(() => adapter.sendTextBatch(key, ['发信关闭但仍可收信']), /关闭/);
  assert.equal(chatAllowed(key, cfg), true);
  cfg.plugins.settings['bilibili-lite'].receiveEnabled = false;
  assert.equal(chatAllowed(key, cfg), false);
  await adapter.receiveBatch('bilibili-lite', { ...batch, events: [{ ...batch.events[0], seqno: '2' }] });
  assert.equal(wakes.length, 1);
  await assert.rejects(() => adapter.sendTextBatch(key, ['已关收信']), /关闭/);
});

test('B站新消息进入真实统一Agent，回复经B站路由而非QQ，仅暴露当前会话工具', async (t) => {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { Orchestrator } = await import('../src/core/orchestrator.js');
  const { SessionRegistry } = await import('../src/core/sessions.js');
  const { SendQueue } = await import('../src/onebot/sender.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active'; cfg.runtime.paused = false;
  cfg.api.model = 'mock'; cfg.api.baseUrl = 'https://model.invalid'; cfg.api.maxRounds = 3;
  cfg.humanize.enabled = false; cfg.sticker.enabled = false; cfg.memory.consolidateEnabled = false;
  cfg.webSearch.enabled = false; cfg.conversation.replyGuardEnabled = false;
  cfg.plugins.enabled = true; cfg.plugins.enabledIds = ['bilibili-lite'];
  cfg.plugins.settings = { 'bilibili-lite': { receiveEnabled: true, receiveUids: '7', sendUids: '7' } };
  cfg.plugins.switches = { 'bilibili-lite': { message_send: true } };
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: fs.mkdtempSync(path.join(root, 'agent-')) });
  const requests = [], sent = [];
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ onebot: {}, store });
  const memory = { formatForPrompt: () => '', formatHandoffForPrompt: () => '', getHandoff: () => null };
  const runner = new Orchestrator({ store, sessions, memory, stickers: {}, sender, onebot: { selfId: '88888', selfNickname: 'bot' } });
  const registry = { hosts: new Map([['bilibili-lite', { state: 'running', callTool: async () => ({ ok: true }) }]]),
    sendBilibiliMessage: async (...args) => { sent.push(args); return { content: JSON.stringify({ ok: true }) }; }
  };
  const adapter = new BilibiliChannel({ registry, store, orchestrator: runner, getConfig: () => cfg });
  adapter.start();
  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body)); round += 1;
    const name = round % 2 ? 'send_message' : 'finish';
    return Response.json({ choices: [{ message: { tool_calls: [{ id: `bili-${round}`, type: 'function', function: {
      name, arguments: JSON.stringify(name === 'finish' ? { summary: '已回复B站私信' } : { messages: ['你好呀'] })
    } }] } }], usage: { total_tokens: 10 } });
  };
  t.after(async () => { globalThis.fetch = originalFetch; adapter.stop(); await runner.abortAll(); store.close(); });
  const key = 'private:bilibili_42_7';
  // receiveBatch schedules the real Agent. Cancel only the aggregation timer before explicitly draining below.
  await adapter.receiveBatch('bilibili-lite', { account: '42', events: [{ mid: '7', seqno: '100', ts: Date.now(), text: '你好' }] });
  await runner.wake(key);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], key);
  assert.equal(sent[0][1], '7');
  assert.equal(sent[0][2], '你好呀');
  assert.ok(requests[0].messages[0].content.includes('B 站私信'));
  assert.ok(requests[0].tools.every(tool => ['send_message', 'finish', 'get_recent_messages', 'get_message_detail'].includes(tool.function.name)));
  const summary = sessions.listSummaries(10)[0];
  assert.equal(sessions.get(summary.id).status, 'done');
});
