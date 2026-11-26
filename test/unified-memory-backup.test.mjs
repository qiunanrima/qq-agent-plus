import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { snapshotLegacyMemory } from '../src/unified-memory/legacy-backup.js';

test('snapshot retains each legacy database including committed WAL data', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'legacy-memory-'));
  const handles = [];
  t.after(() => {
    for (const db of handles) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const filename of ['hippocampus.sqlite', 'living-memory/living-memory.sqlite',
    'personality-memory.sqlite', 'character-life.sqlite']) {
    const target = path.join(dir, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    const db = new DatabaseSync(target);
    handles.push(db);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(data BLOB); INSERT INTO events VALUES(x'00ff00')");
  }
  const { directory } = await snapshotLegacyMemory(dir, path.join(dir, 'copies'));
  const { files } = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(files.length, 4);
  for (const file of files) {
    assert.equal(file.status, 'verified');
    assert.deepEqual(file.tables, [{ name: 'events', rows: 1 }]);
    const db = new DatabaseSync(path.join(directory, file.relative), { readOnly: true });
    try { assert.equal(db.prepare('SELECT hex(data) AS value FROM events').get().value, '00FF00'); }
    finally { db.close(); }
  }
});
