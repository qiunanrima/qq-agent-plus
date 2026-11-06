/** Compatibility is spelling-only: never choose a target or override an explicit one. */
export function normalizeToolArgumentAliases(name, args) {
  if (name !== 'send_poke' || !args || typeof args !== 'object' || Array.isArray(args) || Object.hasOwn(args, 'targetUserId')) return args;
  const aliases = ['userId', 'user_id', 'target_user_id'].filter(key => Object.hasOwn(args, key));
  if (!aliases.length) return args;
  const values = aliases.map(key => args[key]);
  if (values.some(value => (typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d{1,15}$/.test(String(value)))) return args;
  const targets = new Set(values.map(String));
  if (targets.size !== 1) return args;
  const result = { ...args, targetUserId: [...targets][0] };
  for (const key of aliases) delete result[key];
  return result;
}
