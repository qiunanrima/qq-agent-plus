import { readCodexQuotaStatus } from './models.js';

// Adapter 2.6.0's /status is a local command backed by account/rateLimits/read.
// Only quota lines leave this module. Account emails, paths and session IDs do not.
export function parseCodexQuota(text) {
  const windows = [];
  let credits = null, unlimited = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\*\*([^*\r\n]{1,160}):\*\*\s+(\d{1,3})% left(.*)$/.exec(line.trim());
    if (match && Number(match[2]) <= 100 && /limit/i.test(match[1])) {
      windows.push({ name: match[1], remainingPercent: Number(match[2]), reset: match[3].trim().slice(0, 160) });
    }
    const credit = /^\*\*(?:[^*\r\n]* )?Credits:\*\*\s+(unlimited|[0-9]+(?:\.[0-9]+)?)\s*$/.exec(line.trim());
    if (credit) { unlimited = credit[1] === 'unlimited'; if (!unlimited) credits = Number(credit[1]); }
  }
  const plan = /^\*\*Account:\*\* ChatGPT ([a-zA-Z0-9_-]+)/m.exec(text)?.[1] || '';
  return { available: windows.length > 0 || credits !== null || unlimited, windows: windows.slice(0, 32), credits, unlimited, plan };
}

export function createCodexQuotaReader({ query = readCodexQuotaStatus, now = Date.now } = {}) {
  let key, value, pending, retryAt = 0, error = false;
  const signature = cfg => JSON.stringify([cfg?.executable, cfg?.adapterScript, cfg?.workspace]);
  return {
    peek(cfg) { return key === signature(cfg) && value ? { ...value, cached: true, stale: error || now() - Date.parse(value.checkedAt) >= 60000 } : { available: false, windows: [] }; },
    async read(cfg) {
      const next = signature(cfg);
      if (pending) {
        if (key !== next) throw new Error('Codex quota query busy');
        return pending;
      }
      if (key === next && now() < retryAt) {
        if (error) throw new Error('Codex quota query cooling down');
        return { ...value, cached: true };
      }
      key = next; value = undefined;
      pending = Promise.resolve().then(async () => {
        try {
          value = { ...parseCodexQuota(await query(cfg)), checkedAt: new Date(now()).toISOString(), cached: false };
          error = false; retryAt = now() + 60000;
          return value;
        } catch { error = true; retryAt = now() + 15000; throw new Error('Codex quota query failed'); }
        finally { pending = undefined; }
      });
      return pending;
    }
  };
}
export const codexQuotaReader = createCodexQuotaReader();
