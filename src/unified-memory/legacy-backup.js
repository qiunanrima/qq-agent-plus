import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const databases = [
  'hippocampus.sqlite', 'living-memory/living-memory.sqlite',
  'personality-memory.sqlite', 'character-life.sqlite'
];

// The SQLite backup API includes committed WAL pages. Each backup is a
// consistent snapshot of one database; stop legacy writers for final cutover.
export async function snapshotLegacyMemory(dataDir, backupRoot) {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(backupRoot, 'memory-'));
  const files = [];
  for (const relative of databases) {
    const original = path.join(dataDir, relative);
    if (!existsSync(original)) {
      files.push({ relative, status: 'absent' });
      continue;
    }
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const source = new DatabaseSync(original, { readOnly: true });
    try { await backup(source, target); } finally { source.close(); }
    const snapshot = new DatabaseSync(target, { readOnly: true });
    let tables;
    try {
      const checks = snapshot.prepare('PRAGMA integrity_check').all();
      if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
        throw new Error('Snapshot integrity check failed: ' + relative);
      }
      tables = snapshot.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
        .map(({ name }) => {
          const identifier = '"' + name.replaceAll('"', '""') + '"';
          return { name, rows: snapshot.prepare('SELECT count(*) AS n FROM ' + identifier).get().n };
        });
    } finally { snapshot.close(); }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    files.push({ relative, status: 'verified', sha256: hash.digest('hex'), tables });
  }
  const memoryDir = path.join(dataDir, 'memory');
  if (existsSync(memoryDir)) {
    for (const entry of readdirSync(memoryDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const original = path.join(entry.parentPath, entry.name);
      const relative = path.relative(dataDir, original).split(path.sep).join('/');
      const target = path.join(directory, relative);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const bytes = readFileSync(original);
      writeFileSync(target, bytes, { mode: 0o600 });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256) {
        throw new Error('Snapshot checksum mismatch: ' + relative);
      }
      files.push({ relative, status: 'verified', sha256 });
    }
  }
  const manifest = { createdAt: new Date().toISOString(), files };
  const manifestPath = path.join(directory, 'manifest.json');
  writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(manifestPath + '.tmp', manifestPath);
  return { directory, manifest };
}
