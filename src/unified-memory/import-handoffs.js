import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The snapshot preserves files from unknown providers. Only project directory
// names whose original scope can be recovered without guessing.
export function importHandoffs({ directory, store }) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const counts = { imported: 0, unchanged: 0, archiveOnly: 0 };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of manifest.files) {
      if (!file.relative.endsWith('/_handoff.json')) continue;
      const match = /^memory\/(private|group)_(\d+|wechat_[a-f0-9]{64}|bilibili_\d+_\d+)\/_handoff\.json$/.exec(file.relative);
      if (!match) { counts.archiveOnly++; continue; }
      const bytes = readFileSync(path.join(directory, file.relative));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('Handoff snapshot checksum mismatch: ' + file.relative);
      }
      const row = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (!row || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0 ||
          !(row.summary || row.topic || row.nextStep)) { counts.archiveOnly++; continue; }
      const changed = store.record({ scope: match[1] + ':' + match[2], kind: 'experience',
        subject: 'legacy:handoff', source: 'legacy:handoff:' + file.sha256, timestamp: row.updatedAt,
        body: { topic: row.topic, summary: row.summary, nextStep: row.nextStep,
          expiresAt: row.expiresAt, sourceSessionId: row.sourceSessionId, legacyFile: file.relative } });
      counts[changed ? 'imported' : 'unchanged']++;
    }
    store.db.exec('COMMIT');
    return counts;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
