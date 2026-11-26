import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memoryTurn } from '../src/unified-memory/turn.js';
import { UnifiedMemoryStore } from '../src/unified-memory/store.js';

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
