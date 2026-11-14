export const MODEL_FALLBACK_DEFAULTS = Object.freeze({ enabled: false, graduated: false, order: ['agy', 'codex', 'api'] });
export function normalizeModelFallback(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型回退配置必须是对象');
  const cfg = { ...MODEL_FALLBACK_DEFAULTS, ...raw };
  if (typeof cfg.enabled !== 'boolean' || typeof cfg.graduated !== 'boolean') throw new Error('模型回退开关必须是布尔值');
  if (!Array.isArray(cfg.order) || cfg.order.length !== 3 || new Set(cfg.order).size !== 3 || cfg.order.some(x => !MODEL_FALLBACK_DEFAULTS.order.includes(x))) throw new Error('回退顺序必须包含且仅包含 agy、codex、api');
  return { enabled: cfg.enabled, graduated: cfg.graduated, order: [...cfg.order] };
}
