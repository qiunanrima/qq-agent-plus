import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 只协调各模块公开的备份/清理接口，不直接访问其它模块的数据表或文件。
export function resetAllMemory({ dataDir, memory, livingMemory, store, assets, orchestrator, identityBusy = false }) {
  orchestrator.setPaused(true, 'memory-reset');
  if (orchestrator.runningChats.size || orchestrator.consolidating.size
    || livingMemory.activeFlushes || identityBusy) {
    const error = new Error('机器人已暂停；仍有聊天、记忆整理或人物评估任务进行中。等待任务结束后再点清除，本次尚未删除记忆。');
    error.statusCode = 409;
    throw error;
  }
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const directory = path.join(dataDir, 'memory-reset-backups', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600, flush: true });
  // 所有备份完成之前，不删除任何活动数据。备份目录不属于模型的记忆读取范围。
  write('person-memory.json', memory.resetSnapshot());
  write('context.json', store.contextResetSnapshot());
  write('identity-profiles.json', assets.memoryResetSnapshot());
  livingMemory.createResetBackup(path.join(directory, 'living-memory.sqlite'));
  const manifest = { id, at: Date.now(), status: 'prepared', preserves: ['chat-history', 'member-notes', 'configuration', 'previous-backups'] };
  write('manifest.json', manifest);
  let stage = 'living-memory';
  const cleared = {};
  try {
    cleared.semantic = livingMemory.clearAll();
    stage = 'person-memory';
    cleared.people = memory.clearAll();
    stage = 'identity-profiles';
    cleared.identity = assets.clearMemoryProfiles();
    stage = 'context';
    cleared.context = store.clearAllContext();
    write('manifest.json', { ...manifest, status: 'complete', cleared });
    return { ok: true, paused: true, backupId: id, cleared };
  } catch (cause) {
    try { write('manifest.json', { ...manifest, status: 'failed', stage, cleared, error: String(cause.message || cause) }); } catch { /* 原始备份仍保留 */ }
    const error = new Error(`清除在 ${stage} 阶段失败，可能已有部分数据被清除。机器人保持暂停，请使用备份 ${id} 检查恢复；未自动重试。`, { cause });
    error.statusCode = 500;
    throw error;
  }
}
