export const WEIXIN_DEFAULTS = Object.freeze({ enabled: false, graduated: false });
export function normalizeWeixinConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('微信配置必须为对象');
  const cfg = { ...WEIXIN_DEFAULTS, ...raw };
  for (const key of ['enabled', 'graduated']) if (typeof cfg[key] !== 'boolean') throw new Error(`微信 ${key} 必须为布尔值`);
  return { enabled: cfg.enabled, graduated: cfg.graduated };
}
