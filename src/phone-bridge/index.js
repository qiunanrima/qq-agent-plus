import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const endpoint = '/api/phone-bridge/notifications';
const digest = (value) => createHash('sha256').update(value).digest();

export function phoneBridgeEnabled() {
  return /^[a-f0-9]{64}$/i.test(process.env.QQ_AGENT_PHONE_TOKEN ?? '');
}

function readInbox(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'phone-bridge', 'inbox.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function registerPhoneBridge(router, { json, readBody, dataDir = DATA_DIR }) {
  router.add('POST', endpoint, async (req, res) => {
    let events;
    try {
      const payload = await readBody(req, 256 * 1024);
      events = payload?.events;
      if (!Array.isArray(events) || events.length > 30 || events.some((event) =>
        !event || !/^[0-9a-f-]{36}$/i.test(event.id ?? '') ||
        !/^[a-z0-9_.]{1,200}$/i.test(event.source ?? '') ||
        typeof event.title !== 'string' || event.title.length > 256 ||
        typeof event.body !== 'string' || event.body.length > 2048
      )) throw new Error('invalid events');
    } catch {
      return json(res, 400, { error: '通知数据格式无效' });
    }
    if (events.length) {
      const inbox = new Map(readInbox(dataDir).map((event) => [event.id, event]));
      for (const { id, source, title, body } of events) {
        if (!inbox.has(id)) inbox.set(id, { id, source, title, body, receivedAt: new Date().toISOString() });
      }
      const dir = join(dataDir, 'phone-bridge');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, 'inbox.json');
      writeFileSync(target + '.tmp', JSON.stringify([...inbox.values()].slice(-200)), { mode: 0o600 });
      renameSync(target + '.tmp', target);
    }
    return json(res, 200, { accepted: events.map(({ id }) => id) });
  }, {
    authorize(req) {
      return phoneBridgeEnabled() && timingSafeEqual(
        digest(String(req.headers.authorization ?? '')),
        digest('Bearer ' + process.env.QQ_AGENT_PHONE_TOKEN)
      );
    }
  });
}

export function readOwnerPhoneNotifications(ctx, limit) {
  const owner = String(getConfig().admin?.ownerUin ?? '');
  const sender = ctx.triggerEntries?.filter((entry) => !entry?.self).at(-1);
  if (!phoneBridgeEnabled() || !/^[0-9]{5,15}$/.test(owner) ||
      ctx.chatKey !== 'private:' + owner || String(sender?.senderId ?? '') !== owner ||
      !/(?:手机|微信|QQ|应用|系统).{0,12}通知|通知栏|通知收件箱/i.test(String(sender?.text ?? ''))) return null;
  return readInbox(DATA_DIR).slice(-Math.max(1, Math.min(10, Number(limit) || 5))).reverse();
}
