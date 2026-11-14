import { normalizeModelFallback } from './config.js';

/** Only a QQ host tool attempt is a replay boundary, including failed/unknown writes. */
export async function runModelFallback(args, { getConfig, complete, onFallback = () => {} }) {
  const initial = getConfig();
  const cfg = normalizeModelFallback(initial.modelFallback);
  const textOnly = !(args.messages || []).some(m => Array.isArray(m.content) && m.content.some(p => p.type !== 'text'));
  const available = backend => {
    const c = getConfig();
    if (backend === 'api') return Boolean(String(c.api?.baseUrl || '').trim() && String(c.api?.model || '').trim());
    return textOnly && Boolean(args.mcpRun?.execute && args.mcpRun?.allowed) && c[backend === 'agy' ? 'antigravityCli' : 'codexCli']?.enabled === true;
  };
  const controller = new AbortController();
  const upstreamSignal = args.signal;
  args = { ...args, signal: upstreamSignal ? AbortSignal.any([upstreamSignal, controller.signal]) : controller.signal };
  const guard = setInterval(() => {
    if (getConfig().modelFallback?.enabled !== true || args.mcpRun?.allowed?.() === false || args.mcpRun?.channelEnabled?.() === false) {
      controller.abort(Object.assign(new Error('模型回退已停止'), { code: 'RUN_CANCELLED' }));
    }
  }, 100);
  guard.unref?.();
  let attemptedTool = false, previous = null, lastError = null;
  const mcpRun = args.mcpRun && { ...args.mcpRun, execute: (...params) => {
      attemptedTool = true; // Mark before awaiting: errors may mean an unknown outcome.
      return args.mcpRun.execute(...params);
    } };
  try {
    for (const backend of cfg.order) {
      args.signal?.throwIfAborted();
      if (getConfig().modelFallback?.enabled !== true || args.mcpRun?.allowed?.() === false || args.mcpRun?.channelEnabled?.() === false) throw lastError || new Error('模型回退已停止');
      if (!available(backend)) continue;
      if (previous) onFallback(previous, backend, lastError);
      previous = backend;
      try {
        const result = await complete({ ...args, mcpRun }, backend);
        return { ...result, backend, viaFallback: Boolean(lastError) || result.viaFallback, channelChanged: true };
      } catch (error) {
        lastError = error;
        if (!available(backend) || attemptedTool || args.signal?.aborted || error?.code === 'RUN_CANCELLED' || error?.code === 'TIME_CONTROL_INACTIVE' || error?.name === 'AbortError' || args.mcpRun?.isFinished?.()) throw error;
      }
    }
    throw lastError || new Error('模型回退没有可用后端，请启用 CLI 或配置模型 API');
  } finally { clearInterval(guard); }
}
