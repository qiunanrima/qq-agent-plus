import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hippocampus, memoryDay } from '../src/memory/hippocampus.js';

const persona = { botName: '鱼鱼', roleText: '喜欢聊天' };
const at = (s) => Date.parse(`${s}+08:00`);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-hippocampus-'));
  const cfg = { memory: { hippocampusEnabled: true } };
  let now = at('2026-11-01T12:00:00');
  const memory = new Hippocampus({ dataDir: root, getConfig: () => cfg, now: () => now });
  let seq = 0;
  const capture = (summary, { chatKey = 'group:1', role = persona, close = false, id } = {}) => {
    memory.capture({ chatKey, persona: role,
      session: { id: id || `s${++seq}`, episodeSummary: summary, threadDisposition: close ? 'close' : 'listening' },
      triggerEntries: [{ id: seq, eventKind: 'message', senderId: '12345', senderName: '甲', text: summary }] });
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cfg, memory, capture, setTime: (value) => { now = at(value); } };
}
const digest = (content = '甲喜欢一起聊MC') => async (messages) => {
  const { episodes } = JSON.parse(messages[1].content);
  return { cards: [...new Set(episodes.map((r) => r.persona))].map((key) => ({
    episodeIds: episodes.filter((r) => r.persona === key).map((r) => r.id), kind: 'person', subject: '12345', title: '甲的兴趣', content })) };
};

test('03:00按上海时间换日，覆盖年末和闰日边界', () => {
  assert.equal(memoryDay(at('2027-01-01T02:59:59')), '2026-12-31');
  assert.equal(memoryDay(at('2027-01-01T03:00:00')), '2027-01-01');
  assert.equal(memoryDay(at('2028-03-01T02:59:59')), '2028-02-29');
});

test('默认读取无建库；禁用时无采集/注入/工具/模型调用，已有数据保留', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.memory.episodes(), []);
  assert.equal(fs.existsSync(f.memory.file), false);
  f.cfg.memory.hippocampusEnabled = false;
  f.capture('不应保存');
  assert.equal(f.memory.prompt({ persona, chatKey: 'group:1' }), '');
  assert.deepEqual(f.memory.toolDefs({ persona, chatKey: 'group:1' }), []);
  await f.memory.maintain({ complete: () => assert.fail('禁用不调用模型') });
  assert.equal(fs.existsSync(f.memory.file), false);
  f.cfg.memory.hippocampusEnabled = true;
  f.capture('真实聊天');
  f.cfg.memory.hippocampusEnabled = false;
  assert.equal(f.memory.episodes().length, 1);
});

test('同一活跃周期更新100字摘要，重放幂等；显式结束/三分钟空闲另开周期', (t) => {
  const f = fixture(t);
  f.capture('开始聊MC', { id: 'one' });
  f.capture('机器人和甲一起讨论MC服务器', { id: 'two' });
  f.capture('重复回合不覆盖摘要', { id: 'two' });
  assert.equal(f.memory.episodes().length, 1);
  assert.equal(f.memory.episodes()[0].summary, '机器人和甲一起讨论MC服务器');
  f.setTime('2026-11-01T12:03:01');
  f.capture('甲说明天面试', { close: true });
  f.capture('新话题');
  assert.equal(f.memory.episodes().length, 3);
  f.capture('字'.repeat(200));
  assert.ok(f.memory.episodes().some((r) => r.summary === '字'.repeat(100)));
});

test('今日昨日摘要全局互通、角色隔离，查询分页完整，正文不展开', async (t) => {
  const f = fixture(t);
  f.capture('一起猜词没有猜出来', { chatKey: 'group:2' });
  f.capture('聊到深夜要睡觉了', { chatKey: 'private:12345' });
  f.capture('另一个角色的经历', { role: { ...persona, roleText: '另一个角色' } });
  f.setTime('2026-11-02T03:00:00');
  await f.memory.maintain({ complete: digest('保密的长期印象正文') });
  f.capture('今天遇到了甲');
  const prompt = f.memory.prompt({ persona, chatKey: 'group:99' });
  assert.match(prompt, /昨日/);
  assert.match(prompt, /今日/);
  assert.match(prompt, /一起猜词/);
  assert.doesNotMatch(prompt, /另一个角色的经历|保密的长期印象正文/);
  assert.match(prompt, /长期记忆索引/);
  const tools = f.memory.toolDefs({ persona, chatKey: 'group:99' });
  const lookup = tools.find((d) => d.name === 'memory_card_lookup');
  const card = f.memory.cards({ persona, chatKey: 'group:99' })[0];
  assert.match(lookup.execute({}, { id: card.id }).content, /保密的长期印象正文/);
  assert.match(lookup.execute({}, { id: 'not-found' }).content, /没有可见/);
  const recent = JSON.parse(tools.find((d) => d.name === 'hippocampus_lookup').execute({}, { day: 'yesterday', userId: '12345' }).content);
  assert.equal(recent.total, 2);
});

test('凌晨先消化昨日再标记保留，次日才删除更早摘要；重启不重复消化', async (t) => {
  const f = fixture(t);
  f.capture('甲说喜欢MC');
  f.setTime('2026-11-02T02:59:59');
  await f.memory.maintain({ complete: () => assert.fail('尚未换日') });
  f.setTime('2026-11-02T03:01:00');
  await f.memory.maintain({ complete: digest() });
  assert.equal(f.memory.episodes()[0].digested, 1);
  assert.equal(f.memory.episodes().length, 1);
  const restarted = new Hippocampus({ dataDir: f.root, getConfig: () => f.cfg, now: () => at('2026-11-03T03:00:00') });
  await restarted.maintain({ complete: () => assert.fail('已经消化，重启不重复付费') });
  assert.equal(restarted.episodes().length, 0);
  assert.equal(restarted.cards({ persona, chatKey: 'group:2' }).length, 1);
});

test('消化失败与非法来源不丢摘要；一小时后重试，合法结果才清理', async (t) => {
  const f = fixture(t);
  f.capture('甲有重要面试');
  f.setTime('2026-11-03T03:00:00');
  await assert.rejects(f.memory.maintain({ complete: async () => ({ cards: [{ kind: 'person', subject: '12345', title: '甲', content: '正文', episodeIds: ['假的id'] }] }) }), /来源无效/);
  assert.equal(f.memory.episodes().length, 1);
  assert.equal(f.memory.episodes()[0].digested, 0);
  await f.memory.maintain({ complete: () => assert.fail('退避期间不重复付费') });
  f.setTime('2026-11-03T04:01:00');
  await f.memory.maintain({ complete: digest() });
  assert.equal(f.memory.episodes().length, 0);
  assert.equal(f.memory.cards({ persona, chatKey: 'group:1' }).length, 1);
});

test('遵守perChat与私聊隐藏策略，索引和正文查询都不能绕过', async (t) => {
  const f = fixture(t);
  f.capture('私聊讨论的个人喜好', { chatKey: 'private:12345' });
  f.setTime('2026-11-02T03:00:00');
  await f.memory.maintain({ complete: digest('私聊的长期印象') });
  f.cfg.memory.visibility = { hidePrivateInGroup: true };
  assert.doesNotMatch(f.memory.prompt({ persona, chatKey: 'group:1' }), /个人喜好|甲的兴趣/);
  assert.equal(f.memory.cards({ persona, chatKey: 'group:1' }).length, 0);
  f.cfg.memory.visibility = { mode: 'perChat' };
  assert.equal(f.memory.cards({ persona, chatKey: 'private:9' }).length, 0);
  assert.equal(f.memory.cards({ persona, chatKey: 'private:12345' }).length, 1);
});

test('模型等待期间清空或暂停，不会由迟到响应复活；并发仅调用一次', async (t) => {
  const f = fixture(t);
  f.capture('需要保存的经历');
  f.setTime('2026-11-02T03:00:00');
  let resolve;
  let calls = 0;
  const completion = new Promise((r) => { resolve = r; });
  const job = f.memory.maintain({ complete: async (messages) => { calls++; await completion; return digest()(messages); } });
  await f.memory.maintain({ complete: () => assert.fail('不得并发消化') });
  assert.equal(f.memory.active, true);
  f.memory.clearAll();
  resolve();
  await job;
  assert.equal(calls, 1);
  assert.equal(f.memory.episodes().length, 0);
  assert.equal(f.memory.cards({ persona, chatKey: 'group:1' }).length, 0);
});

test('提示词预算有限但两天完整海马均可分页读取，备份可独立恢复', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) f.capture(`${i}：${'确实发生的事件'.repeat(15)}`, { close: true });
  const prompt = f.memory.prompt({ persona, chatKey: 'group:1' });
  assert.ok(prompt.length < 7000);
  assert.match(prompt, /另有/);
  const lookup = f.memory.toolDefs({ persona, chatKey: 'group:1' }).find((t) => t.name === 'hippocampus_lookup');
  const first = JSON.parse(lookup.execute({}, {}).content);
  const second = JSON.parse(lookup.execute({}, { offset: first.nextOffset }).content);
  assert.equal(first.total, 50);
  assert.equal(first.entries.length, 20);
  assert.equal(second.entries.length, 20);
  const backup = path.join(f.root, 'backup.sqlite');
  f.memory.createResetBackup(backup);
  f.memory.clearAll();
  assert.equal(f.memory.episodes().length, 0);
  fs.copyFileSync(backup, f.memory.file);
  assert.equal(f.memory.episodes().length, 50);
});

test('消化等待时暂停/停用阻止提交；空有效结果也必须成功后才标记消化', async (t) => {
  const f = fixture(t);
  f.capture('今天一起闲聊了一会儿');
  f.setTime('2026-11-02T03:00:00');
  let permitted = true;
  await f.memory.maintain({ allowed: () => permitted, complete: async () => { permitted = false; return { cards: [] }; } });
  assert.equal(f.memory.episodes()[0].digested, 0);
  permitted = true;
  await f.memory.maintain({ complete: async () => { f.cfg.memory.hippocampusEnabled = false; return { cards: [] }; } });
  assert.equal(f.memory.episodes()[0].digested, 0);
  f.cfg.memory.hippocampusEnabled = true;
  await f.memory.maintain({ complete: async () => ({ cards: [] }) });
  assert.equal(f.memory.episodes()[0].digested, 1);
  assert.equal(f.memory.cards({ persona, chatKey: 'group:1' }).length, 0);
});

test('海马拒绝旁路生成人格卡，旧人格卡仅后台可见，不向模型召回', async (t) => {
  const f = fixture(t);
  f.cfg.personalityMemory = { enabled: false };
  f.capture('机器人随口说喜欢甜食');
  f.setTime('2026-11-02T03:01:00');
  await assert.rejects(f.memory.maintain({ complete: async (messages) => {
    assert.doesNotMatch(messages[0].content, /person\|personality\|skill/);
    return { cards: [{ episodeIds: [JSON.parse(messages[1].content).episodes[0].id],
      kind: 'personality', subject: 'self', title: '偏好', content: '未经核验的旧人格' }] };
  } }), /人格成长必须经过独立核验/);
  assert.equal(f.memory.episodes()[0].digested, 0);
  const role = f.memory.episodes()[0].persona;
  f.memory.withDb(true, (db) => db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)')
    .run('legacy-personality', role, 'personality', 'self', '旧人格', '未经核验的旧人格', '["group:1"]', Date.now()));
  assert.equal(f.memory.status().cards.length, 1);
  assert.equal(f.memory.cards({ persona, chatKey: 'group:1' }).length, 0);
  assert.doesNotMatch(f.memory.prompt({ persona, chatKey: 'group:1' }), /旧人格/);
});
