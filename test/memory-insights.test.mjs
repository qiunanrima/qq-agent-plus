import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ForgettingStore, withMemoryRecall } from '../src/memory/forgetting.js';
import { memoryInsights } from '../src/memory/insights.js';
import { explainRecall } from '../src/living-memory/explain.js';

test('检索、正文、实际使用各自记录；查看不强化，错误finish不计使用，跨会话隔离且重启保留', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-insights-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forgetting = new ForgettingStore({ dataDir: root });
  assert.deepEqual(forgetting.recentTrace('group:1'), []); assert.deepEqual(fs.readdirSync(root), []);
  const row = { id: 'card-a', kind: 'person', title: '共同项目', content: '长期有效的正文', sourceChatKeys: ['group:1'] };
  let finishError = true;
  const tools = withMemoryRecall([
    { name: 'memory_card_list', execute: async () => ({ content: JSON.stringify({ indexes: [{ id: row.id, title: row.title }] }) }) },
    { name: 'memory_card_lookup', execute: async () => ({ content: JSON.stringify(row) }) },
    { name: 'finish', parameters: { type: 'object', properties: {} }, execute: async () => ({ isError: finishError }) }
  ], { forgetting, personaScope: 'role' });
  const ctx = { chatKey: 'group:1', session: { id: 'run-1' } };
  await tools[0].execute(ctx, {}); assert.equal(ctx.session.memoryRecallIds, undefined);
  const result = JSON.parse((await tools[1].execute(ctx, {})).content);
  assert.equal(forgetting.describe('role:person', row).recallCount, 0);
  await tools[2].execute(ctx, { usedMemoryIds: [result.recallId] });
  assert.equal(forgetting.recentTrace('group:1').some(event => event.stage === 'used'), false);
  finishError = false;
  await tools[2].execute(ctx, { usedMemoryIds: [result.recallId, 'invalid'] });
  assert.equal(forgetting.describe('role:person', row).recallCount, 1);
  const restarted = new ForgettingStore({ dataDir: root });
  assert.deepEqual(restarted.recentTrace('group:2'), []);
  const events = restarted.recentTrace('group:1');
  assert.deepEqual(events.map(event => event.stage), ['used', 'expanded', 'retrieved', 'retrieved']);
  assert.equal(events[0].entries.length, 1); assert.ok(!JSON.stringify(events).includes(row.content));
  restarted.createResetBackup(path.join(root, 'recall.backup.sqlite'));
  assert.equal(fs.existsSync(path.join(root, 'recall.backup.sqlite.trace.sqlite')), true);
  restarted.clearAll(); assert.deepEqual(restarted.recentTrace('group:1'), []);
});

test('只读解释及禁用不写遗忘库；观测故障不会改变工具返回内容或完成结果', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fault-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forgetting = new ForgettingStore({ dataDir: root });
  fs.writeFileSync(path.join(root, 'memory-recall-trace.sqlite'), 'broken database');
  const tools = withMemoryRecall([{ name: 'memory_card_lookup', execute: async () => ({ content: '{"content":"可靠正文"}' }) },
    { name: 'finish', parameters: { properties: {} }, execute: async () => ({ content: 'done' }) }], { forgetting, personaScope: 'role' });
  const ctx = { chatKey: 'group:1', session: { id: 'fault-test' } };
  const result = JSON.parse((await tools[0].execute(ctx, {})).content);
  assert.equal(result.content, '可靠正文');
  assert.equal((await tools[1].execute(ctx, { usedMemoryIds: [result.recallId] })).content, 'done');
});

test('海马及人格解释按保留率排序，查询不加强，隐藏来源不通过审计旁路暴露', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-explain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forgetting = new ForgettingStore({ dataDir: root });
  forgetting.trace({ chatKey: 'group:1', stage: 'expanded', entries: [{ title: '私聊秘密', sourceChatKeys: ['private:2'] }] });
  const memory = { forgetting, hippocampus: { cards: () => [{ id: 'a', kind: 'person', title: '项目', content: '测试项目', sources: '["group:1"]', updated: Date.now() }] } };
  const data = memoryInsights({ memory, config: { memory: { visibility: { mode: 'perChat' } } }, chatKey: 'group:1', query: '项目' });
  assert.equal(data.entries.length, 1); assert.equal(data.entries[0].lexicalMatches, 1);
  assert.equal(data.entries[0].recallCount, 0); assert.deepEqual(data.events[0].entries, []);
  assert.equal(fs.existsSync(forgetting.file), false);
});

test('语义解释保留原始评分；只展开本scope来源，坏payload安全跳过', () => {
  const store = { db: { prepare: () => ({ get: id => id === 'bad' ? { payload_json: '{' }
    : { id, scope_key: id === 'other' ? 'private:2' : 'group:1', payload_json: JSON.stringify({ lines: [{ role: 'user', text: '原始证据' }] }) } }) } };
  const result = explainRecall({ entries: [{ scopeKey: 'group:1', retrieval: { score: 2.3, rrf: 0.4 }, source: { turnIds: ['same', 'other', 'bad'] } }] }, store);
  assert.equal(result.entries[0].retrieval.score, 2.3); assert.equal(result.entries[0].sourceTurns.length, 1);
  assert.equal(result.entries[0].sourceTurns[0].lines[0].text, '原始证据');
});
