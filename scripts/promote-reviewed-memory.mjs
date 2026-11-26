import { readFileSync } from 'node:fs';
import { UnifiedMemoryStore, isLiveMemorySource } from '../src/unified-memory/store.js';

const [filename, reviewFile] = process.argv.slice(2);
if (!filename || !reviewFile) throw new Error('Usage: node scripts/promote-reviewed-memory.mjs DB REVIEW_JSON');
const reviews = JSON.parse(readFileSync(reviewFile, 'utf8'));
if (!Array.isArray(reviews)) throw new Error('Expected a list of reviewed records');
const db = new UnifiedMemoryStore(filename);
try {
  const read = db.db.prepare('SELECT scope, source, timestamp, body FROM revisions WHERE id = ?');
  db.db.exec('BEGIN IMMEDIATE');
  let inserted = 0;
  try {
    for (const { id, expectedSource, kind, topic, summary, evidence, nextStep } of reviews) {
      if (!Number.isSafeInteger(id) || !['agreement', 'preference', 'task', 'relationship'].includes(kind) ||
          ![topic, summary, evidence].every(value => typeof value === 'string' && value.trim())) {
        throw new Error('Incomplete reviewed record: ' + id);
      }
      const old = read.get(id);
      if (!old || old.source !== expectedSource || isLiveMemorySource(old.source)) {
        throw new Error('Legacy source does not match: ' + id);
      }
      const { persona, personaType, speaker } = JSON.parse(old.body);
      inserted += Number(db.record({ scope: old.scope, kind, subject: 'reviewed:' + old.source,
        source: 'reviewed:' + old.source, timestamp: old.timestamp,
        body: { topic, summary, evidence, nextStep, persona, personaType, speaker } }));
    }
    db.db.exec('COMMIT');
  } catch (error) {
    db.db.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ reviewed: reviews.length, inserted }));
} finally { db.close(); }
