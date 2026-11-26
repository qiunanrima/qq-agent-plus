import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memoryTurn } from '../src/unified-memory/turn.js';
import { UnifiedMemoryStore } from '../src/unified-memory/store.js';

test('full memory is available only through a scoped read', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'memory-detail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'memory.sqlite');
  const scope = 'private:123';
  const turn = memoryTurn({ filename, scope, enabled: () => true, entries: [{ id: 1, ts: 1, senderId: '123' }] });
  const ctx = { chatKey: scope };
  const detail = 'A203 周三 08:00';
  const find = name => turn.tools.find(tool => tool.name === name);
  assert.equal(find('record_memory').execute(ctx, { kind: 'agreement', topic: '课表', summary: '本学期课表',
    detail, messageId: '1' }).content, '已记录');
  const search = find('lookup_memory').execute(ctx, { query: 'A203' });
  assert.doesNotMatch(search.content, /A203/);
  const [{ id }] = JSON.parse(search.content);
  assert.equal(JSON.parse(find('read_memory').execute(ctx, { id }).content).detail, detail);
  assert.equal(find('read_memory').execute({ chatKey: 'group:123' }, { id }).isError, true);
  assert.doesNotMatch(memoryTurn({ filename, scope, entries: [], enabled: () => true }).prompt, /A203/);
});

test('bulk imports remain archived while reviewed records enter recall', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reviewed-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'memory.sqlite');
  const scope = 'private:123';
  const store = new UnifiedMemoryStore(filename);
  try {
    for (const [source, summary] of [['hippocampus:old', '周报旧摘要'], ['reviewed:hippocampus:old', '周报周三提交']]) {
      store.record({ scope, kind: 'agreement', subject: source, source, timestamp: 1,
        body: { topic: '周报', speaker: '123', summary } });
    }
  } finally { store.close(); }
  const { prompt, tools } = memoryTurn({ filename, scope, entries: [], enabled: () => true });
  assert.match(prompt, /周报周三提交/);
  assert.doesNotMatch(prompt, /周报旧摘要/);
  const result = tools.find(tool => tool.name === 'lookup_memory').execute({ chatKey: scope }, { query: '周报' });
  assert.deepEqual(JSON.parse(result.content).map(row => row.summary), ['周报周三提交']);
  for (const [id, summary] of [[2, '周四提交'], [3, '周五提交']]) {
    const update = memoryTurn({ filename, scope, enabled: () => true, entries: [{ id, ts: id, senderId: '123' }] });
    assert.equal(update.tools.find(tool => tool.name === 'record_memory').execute({ chatKey: scope },
      { kind: 'agreement', topic: '周报', summary, messageId: String(id) }).content, '已记录');
  }
  const updated = memoryTurn({ filename, scope, entries: [], enabled: () => true }).prompt;
  assert.match(updated, /周五提交/);
  assert.doesNotMatch(updated, /周[三四]提交/);
});

test('a persona change preserves separate revisions for the same speaker and topic', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'memory-personas-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'memory.sqlite');
  const scope = 'private:123';
  const turn = (persona, entries = []) => memoryTurn({
    filename, scope, entries, enabled: () => true, personas: { memory: persona }
  });
  for (const [persona, summary] of [['first', '周三提交'], ['second', '周五提交']]) {
    const { tools } = turn(persona, [{ id: 1, mid: 143871333, ts: 1, senderId: '123' }]);
    const result = tools.find(tool => tool.name === 'record_memory').execute({ chatKey: scope },
      { messageId: '143871333', kind: 'agreement', topic: '周报', summary });
    assert.equal(result.content, '已记录');
  }
  assert.match(turn('first').prompt, /周三提交/);
  assert.doesNotMatch(turn('first').prompt, /周五提交/);
  assert.match(turn('second').prompt, /周五提交/);
  assert.doesNotMatch(turn('second').prompt, /周三提交/);
});

test('corrections survive reopen and replay without crossing chat boundaries', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'unified-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'memory.sqlite');
  const scope = 'private:123';
  let active = true;
  function turn(entries = [], chat = scope) {
    return memoryTurn({ filename, scope: chat, entries, enabled: () => active });
  }
  function write(id, summary) {
    const { tools } = turn([{ id, ts: id, senderId: '123' }]);
    return tools[0].execute({ chatKey: scope }, { messageId: String(id),
      topic: '周报', summary, kind: 'agreement' });
  }
  write(2, '周三交');
  write(1, '周四交');
  write(2, '周三交');
  assert.match(turn().prompt, /周三交/);
  assert.doesNotMatch(turn().prompt, /周四交/);
  assert.doesNotMatch(turn([], 'group:123').prompt, /周三交/);
  active = false;
  assert.equal(write(3, '周五交').isError, true);
  const db = new UnifiedMemoryStore(filename);
  try {
    const [row] = db.current(scope);
    assert.equal(row.source, 'message:2');
    assert.deepEqual(db.history(scope, row.kind, row.subject).map(r => r.source), ['message:2', 'message:1']);
  } finally { db.close(); }
});
