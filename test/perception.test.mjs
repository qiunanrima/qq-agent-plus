import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerceptionWake } from '../src/memory/perception.js';

test('感知标记持久化、按会话角色隔离、只消费成功快照并过期', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perception-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.now();
  const make = () => new PerceptionWake({ dataDir, now: () => now });
  assert.equal(fs.existsSync(path.join(dataDir, 'perception.sqlite')), false);
  const persona = { botName: '猫', roleText: '喜欢红豆' };
  const args = { chatKey: 'group:1', persona, entries: [{ id: 1, text: '红豆' }], complete: async () => ({ message: { content: '{"wake":false,"markedMessageIds":["1","999"],"topic":"红豆"}' } }) };
  const first = await make().perceive(args);
  assert.equal(first.wake, false); assert.equal(first.marked, 1);
  const second = await make().perceive({ ...args, entries: [{ id: 2, text: '你喜欢吗' }], direct: true });
  assert.deepEqual(second.ids, ['1', '2']);
  assert.equal((await make().perceive({ ...args, chatKey: 'group:2', entries: [], direct: true })).ids.length, 0);
  assert.equal((await make().perceive({ ...args, persona: { botName: '另一人' }, entries: [], direct: true })).ids.length, 0);
  await make().perceive({ ...args, entries: [{ id: 3, text: '第三条' }], direct: true });
  make().consume(second, '刚讨论了红豆');
  const remaining = await make().perceive({ ...args, entries: [], direct: true });
  assert.deepEqual(remaining.ids, ['3']); assert.equal(remaining.previous, '刚讨论了红豆');
  now += 86400001;
  assert.deepEqual((await make().perceive({ ...args, entries: [], direct: true })).ids, []);
});

test('无效感知结果不擅自唤醒，取消不写标记', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perception-invalid-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const perception = new PerceptionWake({ dataDir });
  const args = { chatKey: 'group:1', persona: {}, entries: [{ id: 1, text: '无关' }] };
  await assert.rejects(perception.perceive({ ...args, complete: async () => ({ message: { content: '坏JSON' } }) }));
  const decision = await perception.perceive({ ...args, complete: async () => ({ message: { content: '{"wake":true,"markedMessageIds":["999"]}' } }) });
  assert.equal(decision.wake, false);
  await assert.rejects(perception.perceive({ ...args, direct: true, signal: AbortSignal.abort() }));
  assert.deepEqual((await perception.perceive({ ...args, entries: [], direct: true })).ids, []);
});
