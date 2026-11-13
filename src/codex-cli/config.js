import path from 'node:path';
export const CODEX_DEFAULTS = Object.freeze({ enabled: false, graduated: false, executable: 'codex-acp', adapterScript: '', workspace: '', model: '', effort: 'low', timeoutMs: 60000, maxConcurrent: 1, maxToolCalls: 16 });
export function normalizeCodexConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Codex config must be an object');
  const cfg = { ...CODEX_DEFAULTS, ...raw };
  for (const key of ['enabled', 'graduated']) if (typeof cfg[key] !== 'boolean') throw new Error('Invalid Codex lifecycle flag');
  for (const key of ['executable', 'adapterScript', 'workspace', 'model']) {
    if (typeof cfg[key] !== 'string' || /[\r\n\0]/.test(cfg[key])) throw new Error('Invalid Codex ' + key);
    cfg[key] = cfg[key].trim();
  }
  if (!cfg.executable || cfg.model.startsWith('-')) throw new Error('Invalid Codex executable or model');
  if (cfg.adapterScript && !path.isAbsolute(cfg.adapterScript)) throw new Error('Codex adapterScript must be absolute');
  if (cfg.enabled && !path.isAbsolute(cfg.workspace)) throw new Error('Codex requires an absolute workspace');
  if (!['low', 'medium', 'high'].includes(cfg.effort)) throw new Error('Invalid Codex effort');
  for (const [key,min,max] of [['timeoutMs',1000,60000],['maxConcurrent',1,4],['maxToolCalls',1,128]]) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) throw new Error('Invalid Codex ' + key);
  }
  return cfg;
}
export function usesCodex(config, args = {}) { return config?.codexCli?.enabled === true && args.purpose === 'chat' && !args.overrides; }
