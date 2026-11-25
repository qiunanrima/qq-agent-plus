import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const endpoint = '/api/phone-bridge/notifications';
const digest = (value) => createHash('sha256').update(value).digest();

export function phoneBridgeEnabled() {
  return /^[a-f0-9]{64}$/i.test(process.env.QQ_AGENT_PHONE_TOKEN ?? '');
}

function readStored(dataDir, file, fallback) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'phone-bridge', file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeStored(dataDir, file, data) {
  const dir = join(dataDir, 'phone-bridge');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, file);
  writeFileSync(target + '.tmp', JSON.stringify(data), { mode: 0o600 });
  renameSync(target + '.tmp', target);
}

function authorize(req) {
  return phoneBridgeEnabled() && timingSafeEqual(
    digest(String(req.headers.authorization ?? '')),
    digest('Bearer ' + process.env.QQ_AGENT_PHONE_TOKEN)
  );
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
        typeof event.body !== 'string' || event.body.length > 2048 ||
        (event.postedAt !== undefined && (!Number.isSafeInteger(event.postedAt) || event.postedAt <= 0 || event.postedAt > 8.64e15))
      )) throw new Error('invalid events');
    } catch {
      return json(res, 400, { error: '通知数据格式无效' });
    }
    if (events.length) {
      const inbox = new Map(readStored(dataDir, 'inbox.json', []).map((event) => [event.id, event]));
      for (const { id, source, title, body, postedAt } of events) {
        if (!inbox.has(id)) inbox.set(id, {
          id, source, title, body, receivedAt: new Date().toISOString(),
          ...(postedAt === undefined ? {} : { postedAt: new Date(postedAt).toISOString() })
        });
      }
      writeStored(dataDir, 'inbox.json', [...inbox.values()].slice(-200));
    }
    writeStored(dataDir, 'notification-sync.json', { lastSyncAt: new Date().toISOString() });
    return json(res, 200, { accepted: events.map(({ id }) => id) });
  }, { authorize });

  router.add('POST', '/api/phone-bridge/calendar', async (req, res) => {
    let snapshot;
    try {
      const payload = await readBody(req, 256 * 1024);
      if (payload?.mode === 'commands') return syncCalendarCommands(dataDir, payload, json, res);
      const { from, to, timeZone, events } = payload;
      const isTime = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
      if (!isTime(from) || !isTime(to) || to <= from || to - from > 45 * 86400000 ||
          typeof timeZone !== 'string' || timeZone.length > 80 ||
          !Array.isArray(events) || events.length > 300 || events.some((event) =>
            !event || !isTime(event.start) || !isTime(event.end) || event.end < event.start ||
            typeof event.allDay !== 'boolean' || typeof event.title !== 'string' || event.title.length > 160 ||
            typeof event.location !== 'string' || event.location.length > 100
          )) throw new Error('invalid snapshot');
      snapshot = {
        from, to, timeZone, receivedAt: new Date().toISOString(),
        events: events.map(({ start, end, title, location, allDay }) => ({ start, end, title, location, allDay }))
      };
    } catch {
      return json(res, 400, { error: '日程快照格式无效' });
    }
    writeStored(dataDir, 'calendar.json', snapshot);
    return json(res, 200, { accepted: snapshot.events.length });
  }, { authorize });
}

function isOwnerRequest(ctx, pattern) {
  const owner = String(getConfig().admin?.ownerUin ?? '');
  const sender = ctx.triggerEntries?.filter((entry) => !entry?.self).at(-1);
  return phoneBridgeEnabled() && /^[0-9]{5,15}$/.test(owner) &&
      ctx.chatKey === 'private:' + owner && String(sender?.senderId ?? '') === owner &&
      (!pattern || pattern.test(String(sender?.text ?? '')));
}

const notificationApps = new Map([
  ['微信', 'com.tencent.mm'], ['wechat', 'com.tencent.mm'],
  ['qq', 'com.tencent.mobileqq'], ['tim', 'com.tencent.tim']
]);

export function selectPhoneNotifications(inbox, { app, query, since, until, limit } = {}) {
  const name = typeof app === 'string' ? app.trim().toLowerCase() : '';
  const source = notificationApps.get(name) ?? name;
  const keyword = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 100) : '';
  const bound = value => Number.isSafeInteger(value) ? value : null;
  const from = bound(since);
  const to = bound(until);
  if (from !== null && to !== null && from >= to) return { error: '通知查询的结束时间必须晚于开始时间' };

  const matches = inbox.filter(event => {
    if (source && event.source !== source) return false;
    const received = Date.parse(event.postedAt ?? event.receivedAt);
    if (from !== null && !(received >= from)) return false;
    if (to !== null && !(received < to)) return false;
    return !keyword || (event.title + '\n' + event.body).toLowerCase().includes(keyword);
  }).reverse().sort((a, b) => Date.parse(b.postedAt ?? b.receivedAt) - Date.parse(a.postedAt ?? a.receivedAt));
  const count = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || 5));
  const counts = new Map();
  for (const event of matches) counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  return {
    events: matches.slice(0, count),
    matched: matches.length,
    byApp: [...counts].map(([source, count]) => ({ source, count })),
    truncated: matches.length > count,
    lastReceivedAt: inbox.at(-1)?.receivedAt ?? null
  };
}

export function readOwnerPhoneNotifications(ctx, args = {}) {
  if (!isOwnerRequest(ctx)) return null;
  const sender = ctx.triggerEntries.filter(entry => !entry?.self).at(-1);
  const named = [...String(sender.text ?? '').matchAll(/微信|wechat|(?<![a-z])(?:qq|tim)(?![a-z])/gi)]
    .map(match => notificationApps.get(match[0].toLowerCase()));
  const requested = [...new Set(named)];
  const result = selectPhoneNotifications(readStored(DATA_DIR, 'inbox.json', []), {
    ...args, app: args.app || (requested.length === 1 ? requested[0] : undefined)
  });
  if (result.error) return result;
  const sync = readStored(DATA_DIR, 'notification-sync.json', null);
  return { ...result, lastSyncAt: sync?.lastSyncAt ?? result.lastReceivedAt };
}

export function readOwnerCalendar(ctx, { from, to }) {
  if (!isOwnerRequest(ctx, /日程|日历|安排|会议|会前|有空|准备|行程|空档/)) return null;
  return selectPhoneCalendar(readStored(DATA_DIR, 'calendar.json', null), { from, to });
}

export function selectPhoneCalendar(snapshot, { from, to }, now = Date.now()) {
  const start = from ?? now;
  const end = to ?? (start + 7 * 86400000);
  if (![start, end].every(time => Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15) || end <= start) {
    return { error: '请提供有效的日程查询起止时间' };
  }
  const requested = { from: start, to: end };
  if (!snapshot) return { synced: false, coverage: 'none', requested, events: [] };
  const overlapFrom = Math.max(start, snapshot.from);
  const overlapTo = Math.min(end, snapshot.to);
  const coverage = overlapFrom >= overlapTo ? 'none' :
    overlapFrom === start && overlapTo === end ? 'full' : 'partial';
  const events = coverage === 'none' ? [] : snapshot.events.filter(event =>
    event.start < overlapTo && (event.end > overlapFrom || (event.end === event.start && event.start >= overlapFrom))
  );
  return { ...snapshot, synced: true, requested, coverage, events: events.slice(0, 30), truncated: events.length > 30 };
}

function syncCalendarCommands(dataDir, payload, json, res) {
  const { ready, results } = payload;
  if (typeof ready !== 'boolean' || !Array.isArray(results) || results.length > 20 ||
      results.some((item) => !item || !/^[a-f0-9-]{36}$/i.test(item.id ?? '') ||
        !['written', 'failed', 'unknown'].includes(item.status))) {
    return json(res, 400, { error: '日程回执格式无效' });
  }
  const jobs = readStored(dataDir, 'calendar-writes.json', []);
  const now = Date.now();
  let changed = false;
  const acknowledged = [];
  for (const { id, status } of results) {
    const job = jobs.find((candidate) => candidate.id === id);
    if (job?.status === 'dispatched') {
      job.status = status;
      job.updatedAt = now;
      changed = true;
    }
    if (job?.status === status) acknowledged.push(id);
  }
  for (const job of jobs) {
    if (job.status === 'queued' && (job.start <= now || now - job.createdAt > 86400000)) {
      job.status = 'expired';
      job.updatedAt = now;
      changed = true;
    }
  }
  const next = ready ? jobs.find((job) => job.status === 'queued') : null;
  if (next) {
    next.status = 'dispatched';
    next.updatedAt = now;
    changed = true;
  }
  if (changed) writeStored(dataDir, 'calendar-writes.json', jobs);
  return json(res, 200, { acknowledged, command: next ?? null });
}

export function ownerCalendarWrite(ctx, args, dataDir = DATA_DIR) {
  if (!isOwnerRequest(ctx, /日程|日历|会议|行程/)) return null;
  const jobs = readStored(dataDir, 'calendar-writes.json', []);
  if (args.action === 'status') {
    return { jobs: jobs.slice(-10).reverse().map(({ id, title, status, start, updatedAt }) =>
      ({ id, title, status, start, updatedAt })) };
  }
  if (args.action !== 'create' || !isOwnerRequest(ctx, /(?:新建|添加|加到|加进|记到|记进|定|建|排|创建).{0,16}(?:日程|日历|会议|行程)|(?:日程|日历).{0,12}(?:添加|新建|创建)/)) return null;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const location = typeof args.location === 'string' ? args.location.trim() : '';
  const { start, end } = args;
  const now = Date.now();
  if (!title || title.length > 160 || location.length > 100 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start <= now || end <= start || end - start > 86400000 || end > 8.64e15) {
    return { error: '请提供准确的标题、未来开始时间和结束时间，日程最长 24 小时' };
  }
  const duplicate = jobs.find((job) => job.title === title && job.location === location &&
    job.start === start && job.end === end && !['failed', 'expired'].includes(job.status));
  if (duplicate) return { id: duplicate.id, status: duplicate.status };
  const pending = jobs.filter((job) => job.status === 'queued' && job.start > now && now - job.createdAt < 86400000);
  if (pending.length >= 20) return { error: '手机待处理日程队列已满' };
  const last = jobs.filter((job) => !pending.includes(job)).slice(-100);
  const job = { id: randomUUID(), title, location, start, end, createdAt: now, updatedAt: now, status: 'queued' };
  writeStored(dataDir, 'calendar-writes.json', [...last, ...pending, job]);
  return { id: job.id, status: job.status, note: '待手机领取并确认写入，当前尚未写入日历。' };
}
