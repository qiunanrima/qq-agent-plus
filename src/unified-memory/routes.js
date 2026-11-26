import { existsSync } from 'node:fs';
import { isLiveMemorySource, UnifiedMemoryStore } from './store.js';

export function registerUnifiedMemoryRoutes(router, { filename, json, getConfig }) {
  function inspect(empty, operation) {
    if (!existsSync(filename)) return empty;
    const store = new UnifiedMemoryStore(filename, { readOnly: true });
    try { return operation(store); } finally { store.close(); }
  }
  router.add('GET', '/api/unified-memory/status', (req, res) => {
    const scopes = inspect([], store => {
      const counts = new Map();
      for (const { scope, source } of store.db.prepare('SELECT scope, source FROM revisions ORDER BY timestamp DESC').iterate()) {
        if (isLiveMemorySource(source)) counts.set(scope, (counts.get(scope) || 0) + 1);
      }
      return [...counts].map(([scope, revisions]) => ({ scope, revisions }));
    });
    return json(res, 200, { enabled: getConfig().memory?.unifiedEnabled === true, scopes });
  });
  router.add('GET', '/api/unified-memory/records', (req, res, params, url) => {
    const scope = url.searchParams.get('scope');
    if (!scope || scope.length > 250) return json(res, 400, { error: '请选择会话' });
    const kind = url.searchParams.get('kind'), subject = url.searchParams.get('subject');
    if (Boolean(kind) !== Boolean(subject)) return json(res, 400, { error: '查看修订需要类别和主题' });
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return json(res, 400, { error: '无效的分页位置' });
    const rows = inspect([], store => (kind ? store.history(scope, kind, subject) : store.current(scope))
      .filter(row => isLiveMemorySource(row.source)));
    return json(res, 200, { records: rows.slice(offset, offset + 50), total: rows.length });
  });
}
