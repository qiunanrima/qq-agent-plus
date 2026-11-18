// Bounded, local audit metadata only. Reads never create a DB or reinforce memory.
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';

function withTraceDb(forgetting, write, fn) {
  const file = path.join(path.dirname(forgetting.file), 'memory-recall-trace.sqlite');
  if (!write && !fs.existsSync(file)) return fn(null);
  if (write) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = openDatabase(file, { readOnly: !write });
  try { if (write) fs.chmodSync(file, 0o600); return fn(db); } finally { db.close(); }
}

export function clearRecallTrace(forgetting) { return withTraceDb(forgetting, false, db => Boolean(db)) && withTraceDb(forgetting, true, db => db.exec('DELETE FROM recall_events')); }
export function backupRecallTrace(forgetting, file) { return withTraceDb(forgetting, false, db => { if (db) db.prepare('VACUUM INTO ?').run(file); }); }
export function recordRecallTrace(forgetting, { chatKey, sessionId = '', stage, entries = [] } = {}) {
  if (!/^(group|private):\d{1,15}$/.test(chatKey || '') || !['retrieved', 'expanded', 'used'].includes(stage) || !entries.length) return;
  withTraceDb(forgetting, true, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS recall_events (
      id INTEGER PRIMARY KEY, chat_key TEXT NOT NULL, session_id TEXT NOT NULL,
      stage TEXT NOT NULL, at INTEGER NOT NULL, entries_json TEXT NOT NULL
    )`);
    const safe = entries.slice(0, 30).map(row => ({ recallId: String(row.recallId || '').slice(0, 64),
      id: String(row.id || '').slice(0, 80), kind: String(row.kind || '').slice(0, 30),
      title: String(row.title || row.topic || '').slice(0, 120),
      sourceChatKeys: [...new Set((row.sourceChatKeys || []).map(String))].slice(0, 20) }));
    db.prepare('INSERT INTO recall_events(chat_key,session_id,stage,at,entries_json) VALUES(?,?,?,?,?)')
      .run(chatKey, sessionId, stage, forgetting.now(), JSON.stringify(safe));
    db.exec('DELETE FROM recall_events WHERE id NOT IN (SELECT id FROM recall_events ORDER BY id DESC LIMIT 2000)');
  });
}

export function recentRecallTrace(forgetting, chatKey) {
  return withTraceDb(forgetting, false, db => {
    if (!db?.prepare("SELECT 1 FROM sqlite_master WHERE name='recall_events'").get()) return [];
    return db.prepare('SELECT session_id AS sessionId,stage,at,entries_json FROM recall_events WHERE chat_key=? ORDER BY id DESC LIMIT 30')
      .all(chatKey).map(({ entries_json, ...row }) => ({ ...row, entries: JSON.parse(entries_json) }));
  });
}
