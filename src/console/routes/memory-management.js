import { resetAllMemory } from '../../memory/reset.js';
export function registerMemoryManagementRoutes(router, { json, readBody, memory, livingMemory, personalityMemory, store, assets, orchestrator, dataDir, identityBusy, auditWrite, emit }) {
  router.add('GET', '/api/memory/hippocampus', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    return json(res, 200, memory.hippocampus.status({ offset }));
  });
  // 控制台管理视图；不加入模型工具表，正文仍以海马库为唯一来源。
  router.add('GET', '/api/memory/hippocampus/people', async (req, res) => {
    return json(res, 200, memory.hippocampus.inspectionPersonCards());
  });
  router.add('POST', '/api/memory/reset-all', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (body.confirm !== true || body.scope !== 'all' || body.includeArchive !== true) return json(res, 409, { error: '清除所有记忆与消息存档需要显式确认：confirm=true、scope=all、includeArchive=true；请刷新控制台后确认完整删除范围' });
    try {
      const result = resetAllMemory({
        dataDir: dataDir, memory, livingMemory, personalityMemory, store, assets: assets, orchestrator,
        identityBusy: identityBusy()
      });
      auditWrite('memory.reset-all', 'memory:all', { req, backupId: result.backupId, cleared: result.cleared });
      emit('chat-update', { chatKey: '', phase: 'reset-all' });
      emit('memory-update', { chatKey: '', phase: 'reset-all' });
      emit('living-memory-update', { phase: 'reset-all' });
      emit('personality-memory-update', { phase: 'reset-all' });
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.statusCode || 500, { error: String(error.message || error) });
    }
  });
}
