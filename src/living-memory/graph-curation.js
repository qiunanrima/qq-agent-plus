import { stableJson } from './util.js';

const twoWeeks = 14 * 86400000;
const protectedTypes = new Set(['rule', 'commitment', 'profile', 'preference', 'project']);
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function curateGraphRows(rows, { used, now, limit }) {
  const kept = [];
  const unique = new Set();
  let stale = 0;
  let duplicate = 0;
  for (const row of rows) {
    if (used && row.importance <= 3 && !protectedTypes.has(row.type) && !used.has(row.id)
      && row.updatedAt > 0 && now - row.updatedAt >= twoWeeks) {
      stale++;
      continue;
    }
    const key = stableJson([row.scopeKey, row.type, normalize(row.summary), normalize(row.content),
      [...row.entities].sort(), row.relations.map(relation => stableJson(relation)).sort()]);
    if (unique.has(key)) {
      duplicate++;
      continue;
    }
    unique.add(key);
    if (kept.length < limit) kept.push(row);
  }
  return { rows: kept, cleanup: { stale, duplicate, examined: rows.length, visible: kept.length } };
}
