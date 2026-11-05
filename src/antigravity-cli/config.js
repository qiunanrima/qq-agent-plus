import path from 'node:path';

export const ANTIGRAVITY_DEFAULTS = Object.freeze({
  enabled: false, graduated: false, executable: 'agy', workspace: '',
  agent: 'qq-mcp', model: '', effort: 'low', timeoutMs: 60000, maxConcurrent: 1,
  transport: 'mcp', maxToolCalls: 16, qqApproval: false, nativeApproval: false
});

export function normalizeAntigravityConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Antigravity config must be an object');
  const cfg = { ...ANTIGRAVITY_DEFAULTS, ...raw };
  if (typeof cfg.enabled !== 'boolean' || typeof cfg.graduated !== 'boolean') throw new Error('Antigravity lifecycle flags must be boolean');
  if (typeof cfg.qqApproval !== 'boolean' || typeof cfg.nativeApproval !== 'boolean') throw new Error('Antigravity approval flags must be boolean');
  if ((cfg.qqApproval || cfg.nativeApproval) && cfg.transport !== 'mcp') throw new Error('Tool approval requires MCP transport');
  for (const key of ['executable', 'workspace', 'agent', 'model']) {
    if (typeof cfg[key] !== 'string' || /[\r\n\0]/.test(cfg[key])) throw new Error(`Invalid Antigravity ${key}`);
    cfg[key] = cfg[key].trim();
  }
  if (!cfg.executable || !/^[a-zA-Z0-9_-]+$/.test(cfg.agent)) throw new Error('Invalid Antigravity executable or agent');
  if (cfg.enabled && (!cfg.workspace || !path.isAbsolute(cfg.workspace))) throw new Error('Antigravity requires an absolute workspace');
  if (cfg.model.startsWith('-')) throw new Error('Invalid Antigravity model');
  if (!['low', 'medium', 'high'].includes(cfg.effort)) throw new Error('Invalid Antigravity effort');
  if (!['json', 'mcp'].includes(cfg.transport)) throw new Error('Invalid Antigravity transport');
  if (!Number.isInteger(cfg.maxToolCalls) || cfg.maxToolCalls < 1 || cfg.maxToolCalls > 128) throw new Error('Invalid Antigravity maxToolCalls');
  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 600000) throw new Error('Antigravity timeoutMs must be 1000..600000');
  // Preserve old installations while enforcing the conversation process deadline.
  cfg.timeoutMs = Math.min(cfg.timeoutMs, 60000);
  if (!Number.isInteger(cfg.maxConcurrent) || cfg.maxConcurrent < 1 || cfg.maxConcurrent > 4) throw new Error('Antigravity maxConcurrent must be 1..4');
  return cfg;
}

export function usesAntigravity(config, args = {}) {
  return config?.antigravityCli?.enabled === true && args.purpose === 'chat' && !args.overrides;
}
