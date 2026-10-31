export function registerPersonalityMemoryRoutes({ router, memory, readBody, json, emit, auditWrite }) {
  const handle = (action) => async (req, res, params, url) => {
    try { return json(res, 200, await action(req, params, url)); }
    catch (error) { return json(res, error.statusCode || 500, { error: String(error.message || error) }); }
  };
  router.add('GET', '/api/personality-memory/status', handle(() => memory.status()));
  router.add('POST', /^\/api\/personality-memory\/entries\/([0-9a-f-]+)$/, handle(async (req, params) => {
    const body = await readBody(req) || {};
    if (body.confirm !== true) throw Object.assign(new Error('修改人格记忆需要确认'), { statusCode: 409 });
    const result = memory.edit(params[1], body);
    auditWrite('personality-memory.edit', `personality-memory:${params[1]}`, { req });
    emit('personality-memory-update', { phase: 'edit' });
    return result;
  }));
  router.add('DELETE', /^\/api\/personality-memory\/entries\/([0-9a-f-]+)$/, handle(async (req, params) => {
    const body = await readBody(req) || {};
    if (body.confirm !== true) throw Object.assign(new Error('删除人格记忆需要确认'), { statusCode: 409 });
    const result = memory.remove(params[1]);
    auditWrite('personality-memory.delete', `personality-memory:${params[1]}`, { req });
    emit('personality-memory-update', { phase: 'delete' });
    return result;
  }));
}
