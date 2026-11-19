import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { LivingMemoryRuntime } from '../src/living-memory/runtime.js';
import { LivingMemoryStore } from '../src/living-memory/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-living-memory-runtime-'));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

function serviceFixture() {
  return {
    recalls: [],
    async recall(args) {
      this.recalls.push(args);
      return {
        mode: 'hybrid',
        entries: [{ id: 'm_1', type: 'project', summary: '本地 SQLite 向量记忆', content: '向量和卡片都保存在 Agent 数据目录。', importance: 8 }]
      };
    },
    recordTurn(raw) { this.recorded = raw; return { id: 'turn_1' }; },
    async upsertMemory(raw) { this.created = raw; return { ...raw, id: 'm_2' }; },
    health() { return { ok: true, stats: { total: 0, active: 0, vectorReady: 0, turns: 0, scopes: [] } }; },
    store: {
      listMemories: () => ({ entries: [], total: 0 }),
      getMemory: () => null,
      graph: () => ({ nodes: [], edges: [] })
    },
    removeMemory: () => null,
    archiveMemory: () => null,
    close() {}
  };
}

test('shadow mode audits semantic recall without injecting it into the prompt', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'shadow' } }), service
  });
  const result = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: '之前的向量记忆方案是什么？' }] });
  assert.equal(result.text, '');
  assert.equal(result.entries.length, 1);
  assert.deepEqual(service.recalls[0].scopeKeys, ['group:100']);
  runtime.stop();
});

test('active mode injects only current scope memories and keeps private chat opt-in', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', maxInjectChars: 900, allowPrivate: false } }), service
  });
  const group = await runtime.recall({ chatKey: 'group:100', triggerEntries: [{ text: 'SQLite' }] });
  assert.match(group.text, /长期语义记忆/);
  const privateResult = await runtime.recall({ chatKey: 'private:100', triggerEntries: [{ text: 'SQLite' }] });
  assert.equal(privateResult.mode, 'disabled');
  assert.equal(service.recalls.length, 1);
  runtime.stop();
});

test('turn capture skips sensitive source text and never blocks the caller', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'shadow', captureMinMessages: 60, captureIdleMs: 600000 } }), service
  });
  runtime.captureTurn({
    chatKey: 'group:100', sessionId: 's1',
    triggerEntries: [{ text: '我的 API Key 是 should-not-store' }, { text: '下周讨论向量记忆' }],
    sent: [{ text: '好，我们下周讨论。' }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.recorded.scopeKey, 'group:100');
  const text = JSON.stringify(service.recorded.payload);
  assert.doesNotMatch(text, /should-not-store/);
  assert.match(text, /下周讨论向量记忆/);
  runtime.stop();
});

test('disabled runtime does not create its SQLite database while the page is only inspected', () => {
  const dataDir = path.join(root, `disabled-${Date.now()}-${Math.random()}`);
  const runtime = new LivingMemoryRuntime({
    dataDir,
    getConfig: () => ({ livingMemory: { enabled: false } })
  });
  assert.equal(runtime.status().initialized, false);
  assert.deepEqual(runtime.list({ scopeKeys: ['group:100'] }), { total: 0, entries: [] });
  assert.equal(fs.existsSync(path.join(dataDir, 'living-memory', 'living-memory.sqlite')), false);
  runtime.stop();
});

test('active relation expansion enforces prompt scope and preserves direct recall on graph failure', async () => {
  const service = serviceFixture();
  service.store.relatedMemories = () => [
    { id: 'other', scopeKey: 'group:200', status: 'active', summary: '另一群的信息' },
    { id: 'related', scopeKey: 'group:100', status: 'active', summary: '共同经历' }
  ];
  const runtime = new LivingMemoryRuntime({
    dataDir: root,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', maxRecallItems: 3 } }), service
  });
  try {
    const input = { chatKey: 'group:100', triggerEntries: [{ text: 'SQLite' }], expandRelations: true };
    const result = await runtime.recall(input);
    assert.deepEqual(result.directEntries.map(row => row.id), ['m_1']);
    assert.match(result.text, /共同经历/);
    assert.doesNotMatch(result.text, /另一群的信息/);
    service.store.relatedMemories = () => { throw new Error('图谱读取故障'); };
    const fallback = await runtime.recall(input);
    assert.match(fallback.text, /本地 SQLite 向量记忆/);
  } finally { runtime.stop(); }
});

test('new extracted relations need a stored turn and a verbatim quote from an observed participant', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root, service,
    getConfig: () => ({ characterLife: { enabled: true }, livingMemory: { enabled: true, captureIdleMs: 600000 } }),
    complete: async () => ({ message: { content: JSON.stringify([{
      summary: '打雷时有人陪伴', entities: ['打雷', 'QQ:42', 'QQ:99'],
      relations: [
        { source: '打雷', target: 'QQ:42', predicate: '陪伴', quote: '我陪你等到雨停' },
        { source: '打雷', target: 'QQ:42', predicate: '编造', quote: '对话中没有的话' },
        { source: '打雷', target: 'QQ:99', predicate: '冒认', quote: '我陪你等到雨停' }
      ]
    }]) } })
  });
  try {
    runtime.captureTurn({ chatKey: 'group:100', triggerEntries: [{ senderId: '42', text: '我陪你等到雨停' }] });
    assert.equal((await runtime.flush('group:100')).created, 1);
    assert.deepEqual(service.created.entities, ['打雷','QQ:42']);
    assert.deepEqual(service.created.relations, [{
      source: '打雷', target: 'QQ:42', predicate: '陪伴', evidence: { turnId: 'turn_1', quote: '我陪你等到雨停' }
    }]);
  } finally { runtime.stop(); }
});

test('aging drops detail before the normal forgetting threshold removes a card', async () => {
  const service = serviceFixture();
  const runtime = new LivingMemoryRuntime({
    dataDir: root, service,
    getConfig: () => ({ livingMemory: { enabled: true, mode: 'active', maxRecallItems: 1 } })
  });
  try {
    const start = Date.now();
    runtime.forgetting.now = () => start;
    const recall = service.recall.bind(service);
    service.recall = async input => {
      const result = await recall(input);
      result.entries[0].createdAt = start;
      return result;
    };
    const input = { chatKey: 'group:100', triggerEntries: [{ text: 'SQLite' }], expandRelations: true };
    assert.match((await runtime.recall(input)).text, /保存在 Agent 数据目录/);
    runtime.forgetting.now = () => start + 3 * 86400000;
    const aged = await runtime.recall(input);
    assert.match(aged.text, /本地 SQLite 向量记忆/);
    assert.doesNotMatch(aged.text, /保存在 Agent 数据目录/);
    runtime.forgetting.now = () => start + 7 * 86400000;
    assert.equal((await runtime.recall(input)).text, '');
  } finally { runtime.stop(); }
});

test('语义等价审核归档改写副本，保留不同事件且已审核候选不再送审', async () => {
  const store = new LivingMemoryStore({ file: path.join(root, 'review.sqlite') });
  const runtime = new LivingMemoryRuntime({
    dataDir: root, service: { store, close: () => store.close() },
    getConfig: () => ({ characterLife: { enabled: true }, livingMemory: { enabled: true } })
  });
  try {
    const common = { scopeKey: 'group:100', type: 'episode', entities: ['天文照片'] };
    const canonical = store.upsertMemory({ ...common, importance: 8, summary: '一起选好周一的流星雨照片', content: '周一两人从流星雨照片中选出一张。' });
    const paraphrase = store.upsertMemory({ ...common, summary: '周一共同挑选流星雨照片', content: '周一两人一起挑了一张流星雨照片。' });
    const other = store.upsertMemory({ ...common, summary: '周五共同挑选流星雨照片', content: '周五两人一起挑了一张流星雨照片。' });
    let calls = 0;
    const complete = async messages => {
      calls++;
      const pairs = JSON.parse(messages[1].content);
      return { decisions: pairs.map(({ index, cards }) => ({ index, equivalent: cards.every(card => card.content.includes('周一')) })) };
    };
    for (let round = 0; round < 3; round++) await runtime.consolidateForLife('group:100', { allowed: () => true, complete });
    assert.equal(store.getMemory(canonical.id).status, 'active');
    assert.equal(store.getMemory(paraphrase.id).status, 'archived');
    assert.equal(store.getMemory(other.id).status, 'active');
    assert.equal(calls, 2);
  } finally { runtime.stop(); }
});
