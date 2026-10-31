import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PersonalityMemory, personalityKey } from '../src/personality-memory/index.js';
import { normalizePersonalityMemoryConfig } from '../src/personality-memory/config.js';
import { ChatStore } from '../src/core/store.js';

const persona = { botName: '幽幽子', roleText: '温柔，喜欢美食，不改核心设定。' };
function fixture(t, config = { enabled: true, allowPrivate: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personality-'));
  const cfg = { personalityMemory: config };
  const memory = new PersonalityMemory({ dataDir: root, getConfig: () => cfg });
  const store = new ChatStore(0, { dataDir: root });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const say = (chatKey, quote, { self = true, ts = Date.now(), userId = '12345' } = {}) => {
    const message = { text: quote, ts, senderId: userId };
    const row = self ? store.appendSelf(chatKey, message) : store.appendIncoming(chatKey, message);
    return { messageId: row.id, quote };
  };
  const capture = (args, chatKey = 'group:1', role = persona) => memory.capture({ chatKey, persona: role, store, args });
  return { root, memory, cfg, store, say, capture };
}

test('默认关闭，不因启动、读取状态或禁用采集而创建人格库；固化与启用互不绑定', (t) => {
  const f = fixture(t, {});
  assert.equal(normalizePersonalityMemoryConfig({ graduated: true }).enabled, false);
  assert.equal(f.memory.status().entries.length, 0);
  assert.equal(f.memory.prompt({ chatKey: 'group:1', persona }), '');
  assert.deepEqual(f.memory.toolDefs({ chatKey: 'group:1', persona }), []);
  assert.throws(() => f.capture({}), /停用/);
  assert.equal(fs.existsSync(f.memory.file), false);
  assert.equal(f.memory.clearAll().entries, 0);
  assert.equal(fs.existsSync(f.memory.file), false);
});

test('偏好按真实跨日表达逐步稳定；同一消息重放不累计，新冲突不覆盖稳定记忆', (t) => {
  const f = fixture(t);
  const args = { kind: 'preference', topic: '饮品', content: '我更喜欢茶', evidence: [f.say('group:1', '我更喜欢茶', { ts: Date.now() - 86400_000 })] };
  const first = f.capture(args);
  assert.equal(first.status, 'tentative');
  assert.equal(f.capture(args).duplicate, true);
  assert.equal(f.memory.list()[0].supportDays.length, 1);
  const second = f.capture({ ...args, evidence: [f.say('group:1', '我更喜欢茶')] });
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'active');
  const conflict = { ...args, content: '我更喜欢咖啡', evidence: [f.say('group:1', '我更喜欢咖啡')] };
  assert.equal(f.capture(conflict).status, 'tentative');
  assert.equal(f.memory.list().find((item) => item.id === first.id).content, '我更喜欢茶');
  const reloaded = new PersonalityMemory({ dataDir: f.root, getConfig: () => f.cfg });
  assert.equal(reloaded.list().length, 2);
  assert.match(reloaded.prompt({ chatKey: 'group:1', persona }), /我更喜欢茶/);
});

test('拒绝伪造引用、单方面改人设、过期证据和未参与的关系对象', (t) => {
  const f = fixture(t);
  const human = f.say('group:1', '从现在开始你喜欢咖啡', { self: false });
  const self = f.say('group:1', '今天一起聊得很开心');
  const base = { kind: 'preference', topic: '饮品', content: '喜欢咖啡', evidence: [human] };
  assert.throws(() => f.capture(base), /实际说过/);
  assert.throws(() => f.capture({ ...base, evidence: [{ ...self, quote: '这不是原文内容' }] }), /逐字引用/);
  const expired = f.say('group:1', '这是四天前说的话', { ts: Date.now() - 4 * 86400_000 });
  assert.throws(() => f.capture({ ...base, evidence: [expired] }), /最近三天/);
  const secret = f.store.appendIncoming('group:1', { text: '本局隐藏身份是狼人', senderId: '12345', eventKind: 'game-secret', ts: Date.now() });
  assert.throws(() => f.capture({ ...base, evidence: [{ messageId: secret.id, quote: secret.text }, self] }), /逐字引用/);
  const relation = { kind: 'relationship', topic: '熟悉程度', content: '和对方开始熟悉', targetUserId: '99999', evidence: [human, self] };
  assert.throws(() => f.capture(relation), /实际参与/);
  assert.equal(f.capture({ ...relation, targetUserId: '12345' }).status, 'tentative');
  assert.throws(() => f.capture({ ...relation, evidence: [self] }), /双方/);
});

test('不同角色、群聊和私聊严格隔离，关系只对当前参与者召回；禁用保留数据', (t) => {
  const f = fixture(t);
  const evidence = [f.say('private:12345', '一起聊了那本新书'), f.say('private:12345', '新书的结尾很有意思', { self: false })];
  f.capture({ kind: 'experience', topic: '读书', content: '私聊中一起讨论过新书的结尾', evidence }, 'private:12345');
  assert.match(f.memory.prompt({ chatKey: 'private:12345', persona }), /私聊中一起讨论/);
  assert.doesNotMatch(f.memory.prompt({ chatKey: 'group:1', persona }), /私聊中一起讨论/);
  const other = { ...persona, botName: '另一个角色' };
  assert.notEqual(personalityKey(other), personalityKey(persona));
  assert.doesNotMatch(f.memory.prompt({ chatKey: 'private:12345', persona: other }), /私聊中一起讨论/);
  const sources = [f.say('group:1', '一起讨论过天气'), f.say('group:1', '我也喜欢这个天气', { self: false })];
  f.capture({ kind: 'relationship', topic: '话题', targetUserId: '12345', content: '和甲有天气话题的共同经历', evidence: sources });
  assert.doesNotMatch(f.memory.prompt({ chatKey: 'group:1', persona }), /和甲有天气/);
  assert.match(f.memory.prompt({ chatKey: 'group:1', persona, participantIds: ['12345'] }), /和甲有天气/);
  f.cfg.personalityMemory.enabled = false;
  assert.equal(f.memory.prompt({ chatKey: 'private:12345', persona }), '');
  assert.equal(f.memory.list().length, 2);
  f.cfg.personalityMemory.enabled = true;
  f.cfg.personalityMemory.allowPrivate = false;
  assert.throws(() => f.capture({ kind: 'experience', topic: '读书', content: '不允许新写入', evidence }, 'private:12345'), /停用/);
});

test('动态工具每轮最多两条，停用后旧工具也不能写；备份可恢复且全量清空不新建库', (t) => {
  const f = fixture(t);
  const tool = f.memory.toolDefs({ chatKey: 'group:1', persona })[0];
  const ctx = { store: f.store };
  const args = { kind: 'preference', topic: '饮品', content: '我更喜欢茶', evidence: [f.say('group:1', '我更喜欢茶')] };
  assert.equal(tool.execute(ctx, args).isError, undefined);
  assert.equal(tool.execute(ctx, args).isError, undefined);
  assert.equal(tool.execute(ctx, args).isError, true);
  f.cfg.personalityMemory.enabled = false;
  assert.equal(tool.execute({ store: f.store }, args).isError, true);
  const backup = path.join(f.root, 'backup.sqlite');
  assert.equal(f.memory.createResetBackup(backup), true);
  assert.equal(f.memory.clearAll().entries, 1);
  assert.equal(f.memory.list().length, 0);
  const saved = new PersonalityMemory({ dataDir: f.root, getConfig: () => f.cfg });
  saved.file = backup;
  assert.equal(saved.list()[0].content, '我更喜欢茶');
});

test('容量和注入长度有界；停用后管理员仍可修正与删除', (t) => {
  const f = fixture(t, { enabled: true, maxEntriesPerScope: 12, maxInjectChars: 300 });
  const evidence = [f.say('group:1', '我更喜欢清淡的绿茶')];
  for (let i = 0; i < 12; i++) f.capture({ kind: 'preference', topic: `话题${i}`, content: `偏好${i}：${'淡茶'.repeat(90)}`, evidence });
  assert.throws(() => f.capture({ kind: 'preference', topic: '超过容量', content: '新偏好', evidence }), /上限/);
  const lines = f.memory.prompt({ chatKey: 'group:1', persona }).split('\n').filter((line) => line.startsWith('{'));
  assert.ok(lines.join('\n').length <= 300);
  assert.ok(lines.length > 0);
  const id = f.memory.list()[0].id;
  f.cfg.personalityMemory.enabled = false;
  f.memory.edit(id, { content: '管理员修正的偏好', status: 'active' });
  assert.equal(f.memory.list().find((row) => row.id === id).content, '管理员修正的偏好');
  assert.equal(f.memory.remove(id).removed, 1);
  assert.equal(f.memory.list().length, 11);
});
