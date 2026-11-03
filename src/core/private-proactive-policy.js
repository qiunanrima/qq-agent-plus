// 管理员只认系统配置，不根据聊天中自称的身份放宽主动联系。
export const PRIVATE_INITIATIVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function quietPrivateChat(chatKey, cfg = {}) {
  const peer = /^private:(\d+)$/.exec(String(chatKey || ''))?.[1];
  return Boolean(peer) && peer !== String(cfg.admin?.ownerUin || '').trim();
}

export function selfWakeAllowed(chatKey, cfg = {}) {
  return cfg.proactive?.selfWakeEnabled !== false && !quietPrivateChat(chatKey, cfg);
}

export function privateInitiativeAllowed(chatKey, cfg, lastAttemptAt = 0, now = Date.now()) {
  if (!quietPrivateChat(chatKey, cfg)) return true;
  return cfg.proactive?.nonAdminPrivateEnabled === true
    && (!(lastAttemptAt > 0) || now - lastAttemptAt >= PRIVATE_INITIATIVE_COOLDOWN_MS);
}

export function proactiveScopeProbability(cfg = {}, scope = 'group') {
  const fallback = scope === 'private' ? 0.05 : 0.25;
  const raw = scope === 'private' ? cfg.proactive?.privateProbability : cfg.proactive?.probability;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}
