import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Import from a completed snapshot. A semantic card is historical evidence;
// it does not authorize an action even when its original type was a project.
export function importLivingCards({ directory, store }) {
  const db = new DatabaseSync(path.join(directory, 'living-memory/living-memory.sqlite'), { readOnly: true });
  const counts = { imported: 0, unchanged: 0, archiveOnly: 0 };
  try {
    const cards = db.prepare(`SELECT id, scope_key, status, summary, content, type,
      source_json, updated_at, expires_at FROM memories ORDER BY id`);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const card of cards.iterate()) {
        if (!/^(private|group):[^\s:]+$/.test(card.scope_key)) { counts.archiveOnly++; continue; }
        const changed = store.record({ scope: card.scope_key, kind: 'experience',
          subject: 'legacy:living:' + card.id, source: 'living:' + card.id + ':' + card.updated_at,
          timestamp: card.updated_at, closed: card.status !== 'active',
          body: { topic: card.type, summary: card.summary, detail: card.content,
            evidence: card.source_json, expiresAt: card.expires_at } });
        counts[changed ? 'imported' : 'unchanged']++;
      }
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
  return counts;
}
