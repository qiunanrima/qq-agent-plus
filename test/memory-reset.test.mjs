import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-reset-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { ChatStore } = await import('../src/core/store.js');
const { LivingMemoryRuntime } = await import('../src/living-memory/runtime.js');
const { LivingMemoryService } = await import('../src/living-memory/service.js');
const { AssetObserver } = await import('../src/console/asset-observer.js');
const { IdentityStore } = await import('../src/identity/identity-store.js');
const { resetAllMemory } = await import('../src/memory/reset.js');

function fixture(t) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memberNotes = { '12345': '老朋友' };
  updateConfig(cfg);
  const memory = new MemoryStore();
  const store = new ChatStore();
  const livingMemory = new LivingMemoryRuntime({ dataDir: root, getConfig });
  const assets = new AssetObserver({ memory, dataDir: root });
  const orchestrator = { runningChats: new Set(), consolidating: new Set(), setPaused(value) { this.paused = value; } };
  t.after(() => { livingMemory.stop(); memory.close(); store.close(); });
  return { dataDir: root, memory, store, livingMemory, assets, orchestrator };
}

test('全部记忆和消息存档先备份再清除，保留人物身份和配置；重启后也为空', async (t) => {
  const f = fixture(t);
  f.memory.append('group:1', 'memberImpression', '喜欢咖啡', { userId: '12345', target: '甲' });
  f.memory.setHandoff('group:1', { topic: '买咖啡', summary: '准备出门' });
  f.memory.search('group:1', '咖啡');
  f.store.appendIncoming('group:1', { mid: '1', senderId: '12345', senderName: '甲', text: '原聊天存档', ts: Date.now() });
  f.store.appendIncoming('private:12345', { mid: '2', senderId: '12345', senderName: '甲', text: '私聊存档', ts: Date.now(), media: [{ kind: 'image', url: 'https://example.com/image.png' }] });
  const identity = new IdentityStore({ dataDir: root });
  t.after(() => identity.close());
  identity.upsertIdentityAsset({ userId: '12345', primaryName: '甲', chatKey: 'group:1', profileNote: '印象备注' });
  f.store.upsertConversationThread('group:1', { topic: '旧话题' });
  const file = f.livingMemory.databaseFile;
  f.livingMemory.service = new LivingMemoryService({ file, embedder: { ready: () => false } });
  await f.livingMemory.service.upsertMemory({ scopeKey: 'group:1', summary: '约定喝咖啡', content: '周末一起喝咖啡' });
  f.livingMemory.service.store.recordTurn({ scopeKey: 'group:1', payload: { text: '来源回合' } });
  f.livingMemory.pending.set('group:1', [{ lines: [] }]);
  f.livingMemory.lastRecall.set('group:1', { entries: ['旧召回'] });
  const result = resetAllMemory(f);
  assert.equal(result.ok, true);
  assert.equal(f.orchestrator.paused, true);
  assert.equal(f.memory.globalMembers().length, 0);
  assert.equal(f.memory.getHandoff('group:1'), null);
  assert.equal(f.memory.search('group:1', '咖啡').results.length, 0);
  assert.equal(f.store.findByMid('group:1', '1'), null);
  assert.equal(f.store.findByMid('private:12345', '2'), null);
  assert.deepEqual(f.store.recent('group:1'), []);
  assert.equal(f.store.getChatMeta('group:1').total, 0);
  assert.equal(result.cleared.context.messages, 2);
  assert.equal(f.store.getConversationThread('group:1'), null);
  assert.deepEqual(identity.getPerson('12345', { chatKey: 'group:1' }).safeProfile, {});
  assert.equal(identity.getPerson('12345', { chatKey: 'group:1' }).primaryName, '甲');
  assert.equal(f.livingMemory.status().stats.total, 0);
  assert.equal(f.livingMemory.status().stats.turns, 0);
  assert.equal(f.livingMemory.pending.size, 0);
  assert.equal(f.livingMemory.lastRecall.size, 0);
  assert.equal(getConfig().memberNotes['12345'], '老朋友');
  const backup = path.join(root, 'memory-reset-backups', result.backupId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'))).status, 'complete');
  assert.match(fs.readFileSync(path.join(backup, 'person-memory.json'), 'utf8'), /喜欢咖啡/);
  const archive = new ChatStore(0, { filename: path.join(backup, 'messages.sqlite') });
  assert.equal(archive.findByMid('group:1', '1').text, '原聊天存档');
  assert.equal(archive.findByMid('private:12345', '2').media[0].kind, 'image');
  assert.ok(archive.getConversationThread('group:1'));
  archive.close();
  const reopened = new ChatStore();
  assert.deepEqual(reopened.recent('group:1'), []);
  assert.deepEqual(reopened.recent('private:12345'), []);
  reopened.appendIncoming('group:1', { mid: 'new', senderId: '12345', senderName: '甲', text: '新收到的消息', ts: Date.now() });
  assert.equal(reopened.findByMid('group:1', 'new').id, 2);
  assert.equal(reopened.getChatMeta('group:1').total, 1);
  reopened.close();
  const saved = new LivingMemoryService({ file: path.join(backup, 'living-memory.sqlite'), embedder: { ready: () => false } });
  assert.equal(saved.health().stats.total, 1);
  saved.close();
  const reloaded = new MemoryStore();
  assert.equal(reloaded.globalMembers().length, 0);
  reloaded.close();
});

test('旧版 JSON 存档一起备份清空，保留未知发送台账，重启不会导回旧消息', () => {
  const dataDir = fs.mkdtempSync(path.join(root, 'legacy-'));
  const directory = path.join(dataDir, 'messages');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'group_99.json'), JSON.stringify({ messages: [{ mid: 'legacy', text: '旧版消息', ts: Date.now() }] }));
  const store = new ChatStore(0, { dataDir });
  try {
    store.db.prepare('INSERT INTO outbox(id,chat_key,state,payload) VALUES (?,?,?,?)').run('uncertain', 'group:99', 'unknown', '{}');
    const backup = path.join(dataDir, 'backup');
    fs.mkdirSync(backup);
    store.createResetBackup(path.join(backup, 'messages.sqlite'));
    assert.equal(store.clearAllArchive().legacyFiles, 1);
    assert.equal(fs.existsSync(path.join(directory, 'group_99.json')), false);
    assert.match(fs.readFileSync(path.join(backup, 'legacy-messages', 'group_99.json'), 'utf8'), /旧版消息/);
    assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get('uncertain').state, 'unknown');
    assert.equal(store.getChatMeta('group:99').held, 1);
  } finally { store.close(); }
  const reopened = new ChatStore(0, { dataDir });
  try { assert.deepEqual(reopened.recent('group:99'), []); } finally { reopened.close(); }
});

test('消息清除事务失败时，存档与线程上下文一起回滚', () => {
  const dataDir = fs.mkdtempSync(path.join(root, 'rollback-'));
  const store = new ChatStore(0, { dataDir });
  try {
    store.appendIncoming('group:9', { mid: 'keep', text: '保留消息', ts: Date.now() });
    store.upsertConversationThread('group:9', { topic: '保留话题' });
    store.db.exec("CREATE TRIGGER fail_archive_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'delete failed'); END;");
    assert.throws(() => store.clearAllArchive(), /delete failed/);
    assert.equal(store.findByMid('group:9', 'keep').text, '保留消息');
    assert.equal(store.getConversationThread('group:9').topic, '保留话题');
    assert.equal(store.getChatMeta('group:9').total, 1);
  } finally { store.close(); }
});

test('从未启用的长期记忆保持没有数据库；忙碌时暂停但不删数据', (t) => {
  const f = fixture(t);
  f.livingMemory.databaseFile = path.join(root, 'never-enabled', 'memory.sqlite');
  f.memory.append('group:2', 'memberImpression', '保留这条', { userId: '67890', target: '乙' });
  f.orchestrator.consolidating.add('group:2');
  assert.throws(() => resetAllMemory(f), (error) => error.statusCode === 409);
  assert.equal(f.orchestrator.paused, true);
  assert.ok(f.memory.globalMembers().some((m) => m.userId === '67890'));
  f.orchestrator.consolidating.clear();
  resetAllMemory(f);
  assert.equal(fs.existsSync(f.livingMemory.databaseFile), false);
});

test('备份失败不删除任何记忆，也不重试', (t) => {
  const f = fixture(t);
  f.memory.append('group:3', 'memberImpression', '备份失败要留下', { userId: '33333', target: '丙' });
  f.store.appendIncoming('group:3', { mid: 'backup-failure', senderId: '33333', text: '存档也必须保留', ts: Date.now() });
  f.store.createResetBackup = () => { throw new Error('backup failure'); };
  assert.throws(() => resetAllMemory(f), /backup failure/);
  assert.ok(f.memory.globalMembers().some((m) => m.userId === '33333'));
  assert.equal(f.store.findByMid('group:3', 'backup-failure').text, '存档也必须保留');
});

test('停用但有旧数据的语义记忆可以备份清空，不启动后台运行时', async (t) => {
  const dataDir = path.join(root, 'disabled-existing');
  const runtime = new LivingMemoryRuntime({ dataDir, getConfig: () => ({ livingMemory: { enabled: false } }) });
  t.after(() => runtime.stop());
  const seed = new LivingMemoryService({ file: runtime.databaseFile, embedder: { ready: () => false } });
  await seed.upsertMemory({ scopeKey: 'group:8', summary: '旧的记忆', content: '停用前留下' });
  seed.close();
  assert.equal(runtime.createResetBackup(path.join(dataDir, 'backup.sqlite')), true);
  assert.equal(runtime.clearAll().memories, 1);
  assert.equal(runtime.service, null);
  assert.equal(runtime.pruneTimer, null);
});

test('接口需要身份验证与显式全量确认，成功后保持暂停', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'observe';
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: 22671, token: 'memory-reset-test' };
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' };
  cfg.api.priceRemoteUrl = 'none';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  await app.start();
  const endpoint = `http://127.0.0.1:${cfg.server.port}/api/memory/reset-all`;
  const request = (body, auth = true) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-console-token': cfg.server.token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request({ confirm: true, scope: 'all' }, false)).status, 401);
  assert.equal((await request({})).status, 409);
  assert.equal((await request({ confirm: true })).status, 409);
  assert.equal((await request({ confirm: true, scope: 'all' })).status, 409);
  assert.equal((await request({ confirm: true, scope: 'all', includeArchive: true })).status, 200);
  assert.equal(getConfig().runtime.paused, true);
});
