export const PERSONALITY_MEMORY_DEFAULTS = Object.freeze({
  enabled: false, graduated: false, autoCapture: true, allowPrivate: false,
  maxEntriesPerScope: 120, maxInjectChars: 2200, captureMinMessages: 20, captureMinIntervalMs: 1800000
});

export function normalizePersonalityMemoryConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const integer = (key, min, max) => Number.isFinite(Number(value[key]))
    ? Math.max(min, Math.min(max, Math.round(Number(value[key])))) : PERSONALITY_MEMORY_DEFAULTS[key];
  return {
    enabled: value.enabled === true, graduated: value.graduated === true,
    autoCapture: value.autoCapture !== false, allowPrivate: value.allowPrivate === true,
    maxEntriesPerScope: integer('maxEntriesPerScope', 12, 500),
    maxInjectChars: integer('maxInjectChars', 300, 6000),
    captureMinMessages: integer('captureMinMessages', 4, 100),
    captureMinIntervalMs: integer('captureMinIntervalMs', 300000, 86400000)
  };
}
