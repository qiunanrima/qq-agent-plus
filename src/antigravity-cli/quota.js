import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = (executable, args, options) => { const pending = promisify(execFile)(executable, args, options); pending.child.stdin.end(); return pending; };
const text = value => typeof value === 'string' ? value.slice(0, 240) : '';

export function parseQuotaEnvelope(stdout, command) {
  const value = JSON.parse(stdout);
  if (value.status !== 'SUCCESS' || value.command?.name !== command || value.num_turns !== 0) throw new Error('Not a read-only CLI response');
  const data = value.command.data;
  if (!data || typeof data !== 'object') throw new Error('Missing quota data');
  if (command === 'credits') {
    const credits = data.remaining_credits;
    return { remainingCredits: typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : null };
  }
  if (!Array.isArray(data.groups)) throw new Error('Missing quota groups');
  return { groups: data.groups.slice(0, 32).map(group => ({
    name: text(group.name),
    buckets: (Array.isArray(group.buckets) ? group.buckets : []).slice(0, 16).map(bucket => ({
      id: text(bucket.id), name: text(bucket.name), window: text(bucket.window),
      remainingFraction: typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)
        && bucket.remaining_fraction >= 0 && bucket.remaining_fraction <= 1 ? bucket.remaining_fraction : null,
      resetTime: typeof bucket.reset_time === 'string' && Number.isFinite(Date.parse(bucket.reset_time))
        ? new Date(bucket.reset_time).toISOString() : null
    }))
  })) };
}

/** Explicit queries only; shared promise, five-minute cache and failure cooldown. */
export function createQuotaReader({ run = runFile, now = Date.now } = {}) {
  const entries = new Map();
  const read = async (executable, { refresh = false } = {}) => {
    let entry = entries.get(executable);
    if (entry?.pending) return entry.pending;
    if (entry && now() < entry.retryAt && (!refresh || entry.error || now() - Date.parse(entry.value?.checkedAt) < 60000)) {
      if (entry.error) throw new Error(entry.error);
      return { ...entry.value, cached: true, ...(refresh ? { refreshThrottled: true, refreshAfter: new Date(Date.parse(entry.value.checkedAt) + 60000).toISOString() } : {}) };
    }
    if (!entry) { entries.clear(); entry = {}; entries.set(executable, entry); }
    entry.pending = (async () => {
      await Promise.resolve(); // Publish the shared promise before any injected runner can fail.
      try {
        const options = { timeout: 15000, maxBuffer: 256 * 1024, shell: false, windowsHide: true };
        const version = (await run(executable, ['--version'], options)).stdout.trim();
        const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version);
        if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 12)))) throw new Error('Unsupported CLI');
        const query = async command => parseQuotaEnvelope((await run(executable, ['-p', `/${command}`, '--output-format', 'json', '--settings', JSON.stringify({ disableSlashCommands: false, useG1Credits: false, toolPermission: 'strict' })], options)).stdout, command);
        const quota = await query('usage');
        let credits = { remainingCredits: null }, creditsAvailable = false;
        try { credits = await query('credits'); creditsAvailable = credits.remainingCredits !== null; } catch { /* unknown is not zero */ }
        const value = { ...quota, ...credits, creditsAvailable, checkedAt: new Date(now()).toISOString(), cached: false };
        entry.value = value; entry.error = null; entry.retryAt = now() + 300000;
        return value;
      } catch {
        entry.error = '额度查询失败，请检查 CLI 版本、登录状态和网络；一分钟后可重试';
        entry.retryAt = now() + 60000;
        throw new Error(entry.error);
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  };
  read.peek = executable => {
    const entry = entries.get(executable);
    return entry?.value ? { ...entry.value, available: true, cached: true,
      stale: Boolean(entry.error) || now() - Date.parse(entry.value.checkedAt) >= 300000 } : { available: false };
  };
  return read;
}

// Homepage and Agent requests share cache, single-flight and cooldown in-process.
export const antigravityQuotaReader = createQuotaReader();
