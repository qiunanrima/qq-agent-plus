import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ForgettingStore, memoryStrength, retention, recallKey, withMemoryRecall } from '../src/memory/forgetting.js';
import { Hippocampus, personaKey } from '../src/memory/hippocampus.js';

const DAY = 86400000;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-forgetting-'));
  let now = Date.parse('2026-11-13T12:00:00+08:00'), enabled = true;
  const store = new ForgettingStore({ dataDir, now: () => now, enabled: () => enabled });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { store, dataDir, now: () => now, advance: days => { now += days * DAY; }, disable: () => { enabled = false; } };
}

test('遗忘公式、时间边界与对数强化；读取不建库', t => {
  const f = fixture(t), row = { userId: '123', content: '喜欢茶', createdAt: f.now() };
  assert.equal(memoryStrength(0), 1.84);
  assert.equal(memoryStrength(-3), 1.84);
  assert.equal(retention(f.now() + DAY, 0, f.now()), 1);
  f.advance(7);
  const cold = f.store.describe('person', row);
  assert.ok(Math.abs(cold.retention - Math.exp(-7 / 1.84)) < 1e-12);
  assert.equal(fs.existsSync(f.store.file), false);
  assert.deepEqual(f.store.rank('person', [row], { automatic: true }), []);
  assert.deepEqual(f.store.rank('person', [row]), [row], '明确查询仍能找到冷记忆');
  assert.equal(f.store.reinforce([cold.recallId, cold.recallId]), 1);
  const warm = f.store.describe('person', row);
  assert.equal(warm.recallCount, 1); assert.equal(warm.retention, 1);
  assert.ok(warm.strength > cold.strength);
  assert.equal(f.store.reinforce([cold.recallId]), 0);
  f.advance(0.99); assert.equal(f.store.reinforce([cold.recallId]), 0);
  f.advance(0.01); assert.equal(f.store.reinforce([cold.recallId]), 1);
  const reopened = new ForgettingStore({ dataDir: f.dataDir, now: f.now });
  assert.equal(reopened.describe('person', row).recallCount, 2);
  f.advance(7);
  assert.ok(reopened.describe('person', row).retention > cold.retention);
  assert.notEqual(recallKey('person', row), recallKey('other-persona', row));
  assert.notEqual(recallKey('person', row), recallKey('person', { ...row, content: '不喜欢茶了' }));
});

test('只强化读过且finish明确采用的正文；失败、索引、伪造ID均不强化', async t => {
  const f = fixture(t), row = { userId: '123', content: '喜欢茶', createdAt: f.now() };
  const defs = withMemoryRecall([
    { name: 'memory_query', execute: () => ({ content: JSON.stringify({ memberImpression: [row] }) }) },
    { name: 'memory_card_list', execute: () => ({ content: '{"indexes":[{"id":"index-only"}]}' }) },
    { name: 'finish', parameters: { properties: {} }, execute: (_ctx, args) => args.fail ? { isError: true } : { content: '{"finished":true}' } }
  ], { forgetting: f.store, personaScope: 'persona' });
  const ctx = { session: {} };
  await defs[1].execute(ctx, {});
  assert.equal(ctx.session.memoryRecallIds, undefined);
  const result = JSON.parse((await defs[0].execute(ctx, {})).content);
  const id = result.memberImpression[0].recallId;
  assert.equal(fs.existsSync(f.store.file), false);
  await defs[2].execute(ctx, { fail: true, usedMemoryIds: [id] });
  assert.equal(fs.existsSync(f.store.file), false);
  await defs[2].execute(ctx, { usedMemoryIds: ['a'.repeat(64), id, id] });
  assert.equal(f.store.describe('legacy:person', row).recallCount, 1);
  assert.equal(ctx.session.memoryRecallIds.length, 0);
  f.advance(1);
  await defs[2].execute(ctx, { usedMemoryIds: [id] });
  assert.equal(f.store.describe('legacy:person', row).recallCount, 1, '收尾清除资格，不跨轮强化');
});

test('海马临时摘要不衰减，长期卡退出自动索引但按ID仍可读取并重新强化', t => {
  const f = fixture(t), persona = { botName: '测试', roleText: '测试角色' };
  const cfg = { memory: { hippocampusEnabled: true } };
  const memory = new Hippocampus({ dataDir: f.dataDir, getConfig: () => cfg, now: f.now });
  const row = { subject: '123', content: '喜欢茶', updated: f.now() };
  memory.withDb(true, db => db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?)')
    .run('card-1', personaKey(persona), 'person', row.subject, '人物印象', row.content, '["group:1"]', row.updated));
  f.advance(7);
  memory.capture({ persona, chatKey: 'group:1', session: { id: 'new', episodeSummary: '今天一起喝茶' },
    triggerEntries: [{ eventKind: 'message', senderId: '123', text: '喝茶' }] });
  const prompt = () => memory.prompt({ persona, chatKey: 'group:1' });
  assert.match(prompt(), /今天一起喝茶/); assert.doesNotMatch(prompt(), /card-1/);
  const lookup = memory.toolDefs({ persona, chatKey: 'group:1' }).find(d => d.name === 'memory_card_lookup');
  const body = JSON.parse(lookup.execute({}, { id: 'card-1' }).content);
  assert.equal(body.content, '喜欢茶');
  f.store.reinforce([recallKey(`${personaKey(persona)}:person`, body)]);
  assert.match(prompt(), /card-1/);
});

test('停用保留元数据且不写入，备份可读，清空彻底撤销强化', t => {
  const f = fixture(t), row = { content: '偏好', createdAt: f.now() };
  const id = recallKey('person', row);
  f.store.reinforce([id]);
  f.store.createResetBackup(path.join(f.dataDir, 'backup.sqlite'));
  assert.ok(fs.statSync(path.join(f.dataDir, 'backup.sqlite')).size > 0);
  f.disable(); f.advance(7);
  assert.equal(f.store.reinforce([id]), 0);
  assert.equal(f.store.describe('person', row).retention, 1);
  const reader = new ForgettingStore({ dataDir: f.dataDir, now: f.now });
  assert.equal(reader.describe('person', row).recallCount, 1);
  reader.clearAll(); assert.equal(reader.describe('person', row).recallCount, 0);
});
