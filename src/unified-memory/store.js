import { DatabaseSync } from 'node:sqlite';

const kinds = new Set(['agreement', 'preference', 'relationship', 'task', 'experience']);

export function isLiveMemorySource(source) {
  return !/^(legacy:|living:|hippocampus:|personality-memory:|character-life:)/.test(source);
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Missing ' + name);
  return value;
}

// Each row is a complete revision. The current state and its evidence therefore
// become visible in the same commit, including after a crash.
export class UnifiedMemoryStore {
  constructor(filename, { readOnly = false } = {}) {
    this.db = new DatabaseSync(filename, { readOnly });
    if (readOnly) return;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        body TEXT NOT NULL,
        closed INTEGER NOT NULL,
        UNIQUE(scope, kind, subject, source)
      );
      CREATE INDEX IF NOT EXISTS revision_history
        ON revisions(scope, kind, subject, timestamp DESC, id DESC);
    `);
  }

  record({ scope, kind, subject, source, timestamp, body, closed = false }) {
    for (const [key, value] of Object.entries({ scope, subject, source })) required(value, key);
    if (!kinds.has(kind) || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
        !body || typeof body !== 'object' || Array.isArray(body) || typeof closed !== 'boolean') {
      throw new TypeError('Invalid memory revision');
    }
    const result = this.db.prepare(`INSERT INTO revisions
      (scope, kind, subject, source, timestamp, body, closed) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, kind, subject, source) DO NOTHING`)
      .run(scope, kind, subject, source, timestamp, JSON.stringify(body), Number(closed));
    return result.changes === 1;
  }

  current(scope) {
    const rows = this.db.prepare(`SELECT kind, subject, source, timestamp, body FROM (
      SELECT *, row_number() OVER (
        PARTITION BY kind, subject ORDER BY timestamp DESC, id DESC
      ) AS position FROM revisions WHERE scope = ?
    ) WHERE position = 1 AND closed = 0 ORDER BY timestamp DESC, id DESC`).all(required(scope, 'scope'));
    return rows.map(row => ({ ...row, body: JSON.parse(row.body) }));
  }

  history(scope, kind, subject) {
    return this.db.prepare(`SELECT source, timestamp, body, closed FROM revisions
      WHERE scope = ? AND kind = ? AND subject = ? ORDER BY timestamp DESC, id DESC`)
      .all(required(scope, 'scope'), kind, subject)
      .map(row => ({ ...row, closed: Boolean(row.closed), body: JSON.parse(row.body) }));
  }

  close() {
    this.db.close();
  }
}
