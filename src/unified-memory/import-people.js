import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function importPeople({ directory, store }) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const counts = { imported: 0, unchanged: 0, archiveOnly: 0 };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of manifest.files) {
      if (!/^memory\/people\/[\w-]+\.json$/.test(file.relative)) continue;
      const bytes = readFileSync(path.join(directory, file.relative));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error('Person snapshot checksum mismatch: ' + file.relative);
      }
      const member = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      for (const entry of member.impressions || []) {
        const scopes = [...new Set(entry.sourceChatKeys || [])];
        const timestamp = entry.lastObservedAt || entry.createdAt;
        if (scopes.length !== 1 || !/^(private|group):[^\s:]+$/.test(scopes[0]) ||
            !entry.content || !Number.isSafeInteger(timestamp) || timestamp < 0) {
          counts.archiveOnly++;
          continue;
        }
        const id = createHash('sha256').update(JSON.stringify([file.relative, entry.content])).digest('hex');
        const changed = store.record({ scope: scopes[0], kind: 'relationship', subject: 'impression:' + id,
          source: 'legacy:people:' + id + ':' + timestamp, timestamp,
          body: { topic: member.name, speaker: member.userId, summary: entry.content,
            origin: entry.origin, legacyFile: file.relative } });
        counts[changed ? 'imported' : 'unchanged']++;
      }
    }
    store.db.exec('COMMIT');
    return counts;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
