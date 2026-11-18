// Adapted from upstream 2e526b3. Console-only evidence projection, no model calls.
export function explainRecall(result, store) {
  if (!result || !Array.isArray(result.entries)) return result;
  return { ...result, entries: result.entries.map(entry => ({ ...entry,
    sourceTurns: [...new Set(entry.source?.turnIds || [])].slice(0, 4).flatMap(id => {
      const row = store?.db?.prepare('SELECT id,scope_key,session_id,payload_json,created_at FROM turns WHERE id=?').get(id);
      if (!row) return [];
      let payload; try { payload = JSON.parse(row.payload_json); } catch { return []; }
      // Never expand a source from another scope even if an old/imported source ID is invalid.
      if (entry.scopeKey && row.scope_key !== entry.scopeKey) return [];
      return [{ id: row.id, scopeKey: row.scope_key, sessionId: row.session_id, createdAt: row.created_at,
        lines: (Array.isArray(payload.lines) ? payload.lines : []).slice(-6).map(line => ({
          sender: String(line.senderName || line.senderId || line.role || '').slice(0, 80), text: String(line.text || '').slice(0, 500) })) }];
    }) })) };
}
