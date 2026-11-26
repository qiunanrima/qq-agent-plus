import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';

function scopes(value) {
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed)) throw new Error('Invalid legacy scope list');
  return parsed;
}

function* hippocampus(db) {
  for (const table of ['episodes', 'episode_archive']) {
    for (const row of db.prepare('SELECT * FROM ' + table).iterate()) {
      yield { id: 'episode:' + row.id, scope: row.chat, persona: row.persona, at: row.updated,
        summary: row.summary, topic: row.day, kind: 'experience' };
    }
  }
  for (const row of db.prepare('SELECT * FROM cards').iterate()) {
    const sources = [...new Set(scopes(row.sources))];
    yield { id: 'card:' + row.id, scope: sources.length === 1 ? sources[0] : null,
      persona: row.persona, at: row.updated, summary: row.content, topic: row.title, kind: 'experience' };
  }
}

function* personality(db) {
  for (const row of db.prepare('SELECT * FROM entries').iterate()) {
    const sources = new Set([row.scope_key, ...scopes(row.sources_json),
      ...scopes(row.evidence_json).map(e => e.chatKey || row.scope_key)]);
    yield { id: row.id, scope: sources.size === 1 ? row.scope_key : null, persona: row.persona_key,
      at: row.updated_at, summary: row.content, topic: row.topic, speaker: row.target_user_id,
      kind: ['preference', 'relationship'].includes(row.kind) ? row.kind : 'experience',
      closed: row.status !== 'active' || !row.verified };
  }
}

function* life(db) {
  for (const row of db.prepare(`SELECT e.*, m.title, m.reason FROM events e
    LEFT JOIN motives m ON m.event = e.id`).iterate()) {
    yield { id: row.id, scope: row.chat, persona: row.role, at: row.at, speaker: row.actor,
      topic: row.title || row.kind, summary: row.reason || row.kind, kind: 'experience' };
  }
}

export function importPersonaRecords({ directory, store }) {
  const result = {};
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, records] of [['hippocampus', hippocampus], ['personality-memory', personality], ['character-life', life]]) {
      const filename = path.join(directory, name + '.sqlite');
      if (!existsSync(filename)) { result[name] = { absent: true }; continue; }
      const counts = result[name] = { imported: 0, unchanged: 0, archiveOnly: 0 };
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        for (const row of records(db)) {
          if (!/^(private|group):[^\s:]+$/.test(row.scope) || !row.persona || !row.summary) {
            counts.archiveOnly++;
            continue;
          }
          const subject = name + ':' + row.id;
          const changed = store.record({ scope: row.scope, kind: row.kind, subject,
            source: subject + ':' + row.at, timestamp: row.at, closed: Boolean(row.closed),
            body: { topic: row.topic, summary: row.summary, speaker: row.speaker,
              persona: row.persona, personaType: name === 'character-life' ? 'life' : 'memory' } });
          counts[changed ? 'imported' : 'unchanged']++;
        }
      } finally { db.close(); }
    }
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
