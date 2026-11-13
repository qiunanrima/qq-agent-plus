import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../core/sqlite.js';
import { sanitizeUserText } from '../core/util.js';

const DAY = 86400000;
export const memoryStrength = (count = 0) => Math.min(90, 1.84 * (1 + Math.log1p(Math.max(0, Number(count) || 0))));
export function retention(at, count = 0, now = Date.now()) {
  return Math.exp(-Math.max(0, now - at) / DAY / memoryStrength(count));
}
// Content is part of the key: corrected/replaced facts must not inherit old reinforcement.
export function recallKey(scope, row) {
  return crypto.createHash('sha256').update(JSON.stringify([scope,
    String(scope === 'semantic' ? row.id || '' : row.subject ?? row.userId ?? row.target_user_id ?? ''),
    sanitizeUserText(String(row.content || '')).replace(/\s+/g, ' ').trim()])).digest('hex');
}

/** Only usage metadata lives here. Reading never creates files or strengthens memory. */
export class ForgettingStore {
  constructor({ dataDir, enabled = () => true, now = Date.now }) {
    this.file = path.join(dataDir, 'memory-recall.sqlite');
    this.enabled = enabled;
    this.now = now;
  }
  withDb(write, fn) {
    if (!write && !fs.existsSync(this.file)) return fn(null);
    if (write) fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = openDatabase(this.file, { readOnly: !write });
    try {
      if (write) {
        db.exec('CREATE TABLE IF NOT EXISTS recalls (id TEXT PRIMARY KEY, recall_count INTEGER NOT NULL, last_reinforced_at INTEGER NOT NULL)');
        fs.chmodSync(this.file, 0o600);
      }
      return fn(db);
    } finally { db.close(); }
  }
  describe(scope, row, snapshot) {
    const id = recallKey(scope, row);
    let saved;
    if (this.enabled()) {
      try { saved = snapshot ? snapshot.get(id) : this.withDb(false, db => db?.prepare('SELECT * FROM recalls WHERE id=?').get(id)); }
      catch { /* Usage metadata must not prevent reading the underlying memory. */ }
    }
    const at = Number(row.lastObservedAt || row.observedAt || row.updated || row.updatedAt || row.updated_at || row.createdAt || row.created_at) || this.now();
    const count = Number(saved?.recall_count) || 0;
    const last = Math.max(at, Number(saved?.last_reinforced_at) || 0);
    return { recallId: id, recallCount: count, strength: memoryStrength(count),
      lastReinforcedAt: last, retention: this.enabled() ? retention(last, count, this.now()) : 1 };
  }
  rank(scope, rows, { automatic = false } = {}) {
    if (!this.enabled()) return rows;
    let snapshot = new Map();
    const keys = [...new Set(rows.map(row => recallKey(typeof scope === 'function' ? scope(row) : scope, row)))];
    try {
      snapshot = this.withDb(false, db => {
        const found = new Map();
        if (!db) return found;
        for (let offset = 0; offset < keys.length; offset += 128) {
          const batch = keys.slice(offset, offset + 128);
          for (const row of db.prepare(`SELECT * FROM recalls WHERE id IN (${batch.map(() => '?').join(',')})`).all(...batch)) found.set(row.id, row);
        }
        return found;
      });
    }
    catch { /* Fall back to the original observation time if metadata is unavailable. */ }
    return rows.map(row => ({ row, memory: this.describe(typeof scope === 'function' ? scope(row) : scope, row, snapshot) }))
      .filter(({ memory }) => !automatic || memory.retention >= 0.05)
      .sort((a, b) => b.memory.retention - a.memory.retention).map(({ row }) => row);
  }
  reinforce(ids) {
    if (!this.enabled() || !ids.length) return 0;
    const now = this.now();
    return this.withDb(true, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        let changed = 0;
        const statement = db.prepare(`INSERT INTO recalls VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET
          recall_count=recall_count+1,last_reinforced_at=excluded.last_reinforced_at
          WHERE recalls.last_reinforced_at<=?`);
        for (const id of [...new Set(ids)].slice(0, 20)) {
          if (/^[a-f0-9]{64}$/.test(id)) changed += Number(statement.run(id, now, now - DAY).changes);
        }
        db.exec('COMMIT'); return changed;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  createResetBackup(file) {
    return this.withDb(false, db => { if (db) db.prepare('VACUUM INTO ?').run(file); });
  }
  clearAll() {
    return this.withDb(false, db => Boolean(db)) && this.withDb(true, db => db.exec('DELETE FROM recalls'));
  }
}

const memoryTools = new Set(['memory_query', 'person_memory_lookup', 'memory_card_lookup', 'personality_lookup', 'semantic_memory_lookup']);
/** A result merely registers eligibility; only successful finish explicitly confirms actual use. */
export function withMemoryRecall(definitions, { forgetting, personaScope }) {
  return definitions.map(def => {
    if (def.name === 'finish') return { ...def,
      parameters: { ...def.parameters, properties: { ...def.parameters.properties,
        usedMemoryIds: { type: 'array', maxItems: 20, items: { type: 'string' },
          description: '本轮实际用于回复/任务的长期记忆 recallId；只填已读正文的ID，不填仅搜索到或未采用的资料。' } } },
      execute: async (ctx, args) => {
        const result = await def.execute(ctx, args);
        if (!result.isError && !ctx.signal?.aborted && forgetting.enabled()) {
          const eligible = ctx.session.memoryRecallIds || [];
          const used = (Array.isArray(args.usedMemoryIds) ? args.usedMemoryIds : []).filter(id => eligible.includes(id));
          // Reinforcement is best effort and must never turn a completed finish into a retry.
          try { forgetting.reinforce(used); } catch { /* metadata unavailable: no reinforcement */ }
          ctx.session.memoryRecallIds = [];
        }
        return result;
      } };
    if (!memoryTools.has(def.name)) return def;
    return { ...def, execute: async (ctx, args) => {
      const result = await def.execute(ctx, args);
      if (result.isError || ctx.signal?.aborted || !forgetting.enabled()) return result;
      let payload;
      try { payload = JSON.parse(result.content); } catch { return result; }
      const visit = value => {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(visit);
        // Index entries and episode summaries have no content and are never reinforced.
        if (typeof value.content === 'string' && value.content.trim()) {
          const source = def.name === 'person_memory_lookup'
            ? ctx.memory?.query?.(ctx.chatKey)?.memberImpression?.find(row => String(row.userId) === String(args.userId)
              && sanitizeUserText(row.content) === value.content) : null;
          const row = { ...value, ...source, userId: value.userId ?? source?.userId ?? (def.name === 'person_memory_lookup' ? args.userId : undefined) };
          const scope = def.name === 'semantic_memory_lookup' ? 'semantic'
            : def.name === 'personality_lookup' ? `${personaScope}:personality`
            : value.kind === 'skill' ? `${personaScope}:skill`
              : row.origin === 'hippocampus' || def.name === 'memory_card_lookup' ? `${personaScope}:person` : 'legacy:person';
          const memory = forgetting.describe(scope, row);
          const ids = new Set(ctx.session.memoryRecallIds || []);
          if (ids.size < 200) ids.add(memory.recallId);
          ctx.session.memoryRecallIds = [...ids];
          return { ...value, ...memory };
        }
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
      };
      try { return { ...result, content: JSON.stringify(visit(payload)) }; }
      catch { return result; }
    } };
  });
}
