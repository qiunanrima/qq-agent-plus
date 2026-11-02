import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-hippo-integration-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { resolvePersona } = await import('../src/personas.js');

test('真实MemoryStore按QQ与关键词查询新人物卡，提示词只展示索引，旧印象不丢失', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  setRuntimeConfig(cfg);
  const memory = new MemoryStore();
  t.after(() => { memory.close(); fs.rmSync(root, { recursive: true, force: true }); });
  memory.append('group:1', 'memberImpression', '旧印象的秘密正文', { userId: '12345', target: '甲' });
  const index = memory.formatIndexForPrompt('group:2', { userIds: ['12345'] });
  assert.match(index, /12345/);
  assert.match(index, /memory_query/);
  assert.doesNotMatch(index, /旧印象的秘密正文/);
  let now = Date.parse('2026-11-01T12:00:00+08:00');
  memory.hippocampus.now = () => now;
  memory.hippocampus.capture({ chatKey: 'group:1', persona: resolvePersona(cfg, 'group:1'),
    session: { id: 'one', episodeSummary: '甲喜欢研究红石电路' },
    triggerEntries: [{ eventKind: 'message', senderId: '12345', senderName: '甲', text: '红石电路' }] });
  now = Date.parse('2026-11-02T03:00:00+08:00');
  await memory.hippocampus.maintain({ complete: async (messages) => {
    const episodes = JSON.parse(messages[1].content).episodes;
    return { cards: [{ episodeIds: [episodes[0].id], kind: 'person', subject: '12345', title: '兴趣', content: '甲喜欢研究红石电路' }] };
  } });
  assert.ok(memory.query('group:2').memberImpression.some((r) => r.content.includes('红石电路')));
  assert.ok(memory.search('group:2', '红石电路', { userId: '12345' }).results.some((r) => r.content.includes('红石电路')));
  assert.ok(memory.query('group:2').memberImpression.some((r) => r.content.includes('旧印象')));
  cfg.memory.visibility = { mode: 'perChat' };
  assert.equal(memory.search('group:2', '红石电路').results.length, 0);
  assert.equal(memory.query('group:2').memberImpression.length, 0);
  assert.throws(() => updateConfig({ memory: { hippocampusEnabled: 'true' } }), /必须是布尔值/);
});
