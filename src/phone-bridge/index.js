import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const endpoint = '/api/phone-bridge/notifications';
const calendarReadFile = 'calendar-reads.json';
const calendarReadMaxSpan = 45 * 86400000;
const calendarReadLifetime = 86400000;
const calendarWaiters = new Map();
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
  if (file === calendarReadFile || file === 'calendar-writes.json') calendarWaiters.get(dataDir)?.();
}

function calendarWorkReady(dataDir, canWrite) {
  const now = Date.now();
  return readStored(dataDir, calendarReadFile, []).some(item =>
    !item.snapshot && now - item.createdAt < calendarReadLifetime) ||
    (canWrite && readStored(dataDir, 'calendar-writes.json', []).some(item =>
      item.status === 'queued' && item.start > now && now - item.createdAt < calendarReadLifetime));
}

function waitForCalendarWork(dataDir, canWrite, res, json, timeout) {
  if (calendarWorkReady(dataDir, canWrite)) return json(res, 200, { pending: true });
  if (calendarWaiters.has(dataDir)) return json(res, 409, { error: '已有手机等待日程任务' });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      res.off('close', close);
      calendarWaiters.delete(dataDir);
    };
    const finish = pending => {
      cleanup();
      resolve(json(res, 200, { pending }));
    };
    const close = () => {
      cleanup();
      resolve();
    };
    const check = expired => {
      try {
        const pending = calendarWorkReady(dataDir, canWrite);
        if (pending || expired) finish(pending);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const timer = setTimeout(() => check(true), timeout);
    res.once('close', close);
    calendarWaiters.set(dataDir, () => check(false));
  });
}

function authorize(req) {
  return phoneBridgeEnabled() && timingSafeEqual(
    digest(String(req.headers.authorization ?? '')),
    digest('Bearer ' + process.env.QQ_AGENT_PHONE_TOKEN)
  );
}

export function registerPhoneBridge(router, { json, readBody, dataDir = DATA_DIR, calendarWaitMs = 20000 }) {
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
        const previous = inbox.get(id);
        if (!previous) inbox.set(id, {
          id, source, title, body, receivedAt: new Date().toISOString(),
          ...(postedAt === undefined ? {} : { postedAt: new Date(postedAt).toISOString() })
        });
        else if (postedAt !== undefined && !previous.postedAt &&
          previous.source === source && previous.title === title && previous.body === body) {
          previous.postedAt = new Date(postedAt).toISOString();
        }
      }
      writeStored(dataDir, 'inbox.json', [...inbox.values()].slice(-200));
    }
    writeStored(dataDir, 'notification-sync.json', { lastSyncAt: new Date().toISOString() });
    return json(res, 200, { accepted: events.map(({ id }) => id) });
  }, { authorize });

  router.add('POST', '/api/phone-bridge/calendar', async (req, res) => {
    let snapshot;
    let requestId;
    try {
      const payload = await readBody(req, 256 * 1024);
      if (payload?.mode === 'wait') {
        if (typeof payload.canWrite !== 'boolean') return json(res, 400, { error: '日程等待参数无效' });
        return await waitForCalendarWork(dataDir, payload.canWrite, res, json, calendarWaitMs);
      }
      if (payload?.mode === 'commands') return syncCalendarCommands(dataDir, payload, json, res);
      if (payload?.mode === 'read-request') {
        const request = readStored(dataDir, calendarReadFile, []).find(item =>
          !item.snapshot && Date.now() - item.createdAt < calendarReadLifetime);
        return json(res, 200, { request: request ? { id: request.id, from: request.from, to: request.to } : null });
      }
      requestId = payload?.requestId;
      const { from, to, timeZone, events } = payload;
      const isTime = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
      if (!isTime(from) || !isTime(to) || to <= from || to - from > calendarReadMaxSpan ||
          typeof timeZone !== 'string' || timeZone.length > 80 ||
          !Array.isArray(events) || events.length > 300 || events.some((event) =>
            !event || !isTime(event.start) || !isTime(event.end) || event.end < event.start ||
            typeof event.allDay !== 'boolean' || typeof event.title !== 'string' || event.title.length > 160 ||
            typeof event.location !== 'string' || event.location.length > 100
          )) throw new Error('invalid snapshot');
      snapshot = {
        from, to, timeZone, receivedAt: new Date().toISOString(),
        ...(requestId !== undefined && payload.truncated === true ? { truncated: true } : {}),
        ...(['manual', 'periodic', 'notification', 'scheduled', 'calendar_change', 'live'].includes(payload.syncTrigger)
          ? { syncTrigger: payload.syncTrigger } : {}),
        events: events.map(({ start, end, title, location, allDay, eventId }) => ({
          start, end, title, location, allDay,
          ...(typeof eventId === 'string' && /^[1-9]\d{0,18}$/.test(eventId) ? { eventId } : {})
        }))
      };
    } catch {
      return json(res, 400, { error: '日程快照格式无效' });
    }
    if (requestId !== undefined) {
      const requests = readStored(dataDir, calendarReadFile, []);
      const request = requests.find(item => item.id === requestId);
      if (!request || request.from !== snapshot.from || request.to !== snapshot.to) {
        return json(res, 409, { error: '日程查询与请求不匹配' });
      }
      if (!request.snapshot) {
        request.snapshot = snapshot;
        writeStored(dataDir, calendarReadFile, requests);
      }
    } else {
      writeStored(dataDir, 'calendar.json', snapshot);
    }
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

export function selectPhoneNotifications(inbox, { app, apps, query, since, until, limit } = {}) {
  const names = Array.isArray(apps) && apps.length ? apps : (app ? [app] : []);
  const sources = new Set(names.filter(name => typeof name === 'string').map(name => {
    const normalized = name.trim().toLowerCase();
    return notificationApps.get(normalized) ?? normalized;
  }).filter(Boolean));
  const keyword = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 100) : '';
  const bound = value => Number.isSafeInteger(value) ? value : null;
  const from = bound(since);
  const to = bound(until);
  if (from !== null && to !== null && from >= to) return { error: '通知查询的结束时间必须晚于开始时间' };

  const matches = inbox.filter(event => {
    if (sources.size && !sources.has(event.source)) return false;
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
    ...args, apps: args.app || args.apps?.length ? args.apps : requested
  });
  if (result.error) return result;
  const sync = readStored(DATA_DIR, 'notification-sync.json', null);
  return { ...result, lastSyncAt: sync?.lastSyncAt ?? result.lastReceivedAt };
}

export function readOwnerCalendar(ctx, range) {
  if (!isOwnerRequest(ctx, /日程|日历|安排|会议|会前|有空|准备|行程|空档|约|空闲/)) return null;
  if (range.durationMinutes === undefined) return requestPhoneCalendar(DATA_DIR, range);
  return requestCalendarAvailability(DATA_DIR, range);
}

export function requestCalendarAvailability(dataDir, range, now = Date.now()) {
  const { durationMinutes, bufferMinutes = 0, exclude = [] } = range;
  const from = range.from ?? now;
  const to = range.to ?? from + 7 * 86400000;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440 ||
      !Number.isSafeInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 1440 ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
    return { error: '请提供有效的查询时间、会议时长和间隔分钟数' };
  }
  if (!Array.isArray(exclude) || exclude.length > 60 || exclude.some(item =>
    !Number.isSafeInteger(item?.from) || !Number.isSafeInteger(item?.to) || item.to <= item.from)) {
    return { error: '请提供有效的避开时段，最多 60 段' };
  }
  const buffer = bufferMinutes * 60000;
  const calendar = requestPhoneCalendar(dataDir, { from: from - buffer, to: to + buffer }, now, Infinity);
  if (calendar.error) return calendar;
  const { coverage, truncated, requestedSync, timeZone, receivedAt, events, completedSegments, totalSegments } = calendar;
  const result = { requested: { from, to }, coverage, truncated, requestedSync, timeZone, receivedAt, completedSegments, totalSegments };
  if (coverage !== 'full' || truncated) return result;
  const available = findCalendarWindows(events, { from, to, durationMinutes, bufferMinutes, exclude });
  return { ...result, available: available.slice(0, 30), availableTruncated: available.length > 30 };
}

export function findCalendarWindows(events, { from, to, durationMinutes, bufferMinutes, exclude = [] }) {
  const duration = durationMinutes * 60000;
  const buffer = bufferMinutes * 60000;
  const busy = [
    ...events.map(event => ({ start: event.start - buffer, end: event.end + buffer })),
    ...exclude.map(item => ({ start: item.from, end: item.to }))
  ]
    .filter(event => event.end > from && event.start < to && event.start < event.end)
    .sort((a, b) => a.start - b.start);
  const windows = [];
  let cursor = from;
  for (const event of busy) {
    if (event.start - cursor >= duration) windows.push({ from: cursor, to: event.start });
    cursor = Math.max(cursor, event.end);
  }
  if (to - cursor >= duration) windows.push({ from: cursor, to });
  return windows;
}

export function requestPhoneCalendar(dataDir, range, now = Date.now(), maxEvents = 30) {
  const ordinary = selectPhoneCalendar(readStored(dataDir, 'calendar.json', null), range, now, maxEvents);
  if (ordinary.error || ordinary.coverage === 'full') return ordinary;
  const { from, to } = ordinary.requested;
  const total = Math.ceil((to - from) / calendarReadMaxSpan);
  if (total > 12) return { ...ordinary, requestedSync: 'range_too_wide' };
  const requests = readStored(dataDir, calendarReadFile, [])
    .filter(item => now - item.createdAt < calendarReadLifetime);
  if (total > 1) return requestCalendarChunks(dataDir, ordinary, requests, now, total, maxEvents);
  const same = requests.find(item => item.from === from && item.to === to);
  if (same) return same.snapshot
    ? selectPhoneCalendar(same.snapshot, range, now, maxEvents)
    : { ...ordinary, requestedSync: 'pending', requestId: same.id };
  const covering = requests.find(item => item.snapshot && item.from <= from && item.to >= to);
  if (covering) return selectPhoneCalendar(covering.snapshot, range, now, maxEvents);
  if (requests.filter(item => !item.snapshot).length >= 12) return { ...ordinary, requestedSync: 'queue_full' };
  const request = { id: randomUUID(), from, to, createdAt: now };
  writeStored(dataDir, calendarReadFile, [...requests.slice(-35), request]);
  return { ...ordinary, requestedSync: 'pending', requestId: request.id };
}

function requestCalendarChunks(dataDir, ordinary, requests, now, total, maxEvents) {
  const { from, to } = ordinary.requested;
  const snapshots = [];
  const additions = [];
  let pending = requests.filter(item => !item.snapshot).length;
  for (let start = from; start < to; start += calendarReadMaxSpan) {
    const end = Math.min(start + calendarReadMaxSpan, to);
    const existing = requests.find(item => item.from === start && item.to === end);
    if (existing?.snapshot) snapshots.push(existing.snapshot);
    if (existing || pending >= 12) continue;
    additions.push({ id: randomUUID(), from: start, to: end, createdAt: now });
    pending++;
  }
  if (additions.length) {
    const kept = requests.filter(item => (item.to > from && item.from < to) || !item.snapshot);
    const spare = requests.filter(item => !kept.includes(item));
    writeStored(dataDir, calendarReadFile, [...spare, ...kept, ...additions].slice(-36));
  }
  if (snapshots.length < total) return {
    ...ordinary, requestedSync: 'pending', completedSegments: snapshots.length, totalSegments: total
  };
  const events = new Map();
  for (const snapshot of snapshots) {
    for (const event of snapshot.events) {
      const key = JSON.stringify([event.eventId, event.start, event.end, event.title, event.location, event.allDay]);
      events.set(key, event);
    }
  }
  const first = snapshots[0];
  return selectPhoneCalendar({
    from, to, timeZone: first.timeZone, receivedAt: snapshots.map(item => item.receivedAt).sort()[0],
    syncTriggers: [...new Set(snapshots.map(item => item.syncTrigger ?? 'unknown'))],
    events: [...events.values()].sort((a, b) => a.start - b.start),
    truncated: snapshots.some(item => item.truncated)
  }, { from, to }, now, maxEvents);
}

export function selectPhoneCalendar(snapshot, { from, to }, now = Date.now(), maxEvents = 30) {
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
  return { ...snapshot, synced: true, requested, coverage, events: events.slice(0, maxEvents),
    truncated: Boolean(snapshot.truncated) || events.length > maxEvents };
}

function syncCalendarCommands(dataDir, payload, json, res) {
  const { ready, results } = payload;
  if (typeof ready !== 'boolean' || !Array.isArray(results) || results.length > 20 ||
      results.some((item) => !item || !/^[a-f0-9-]{36}$/i.test(item.id ?? '') ||
        !['written', 'failed', 'unknown', 'conflict'].includes(item.status))) {
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
  const next = ready ? jobs.find((job) => job.status === 'queued' && (job.operation !== 'update' || payload.canUpdate === true)) : null;
  if (next) {
    next.status = 'dispatched';
    next.updatedAt = now;
    changed = true;
  }
  if (changed) writeStored(dataDir, 'calendar-writes.json', jobs);
  return json(res, 200, { acknowledged, command: next ?? null });
}

export function ownerCalendarWrite(ctx, args, dataDir = DATA_DIR) {
  if (!isOwnerRequest(ctx)) return null;
  const jobs = readStored(dataDir, 'calendar-writes.json', []);
  if (args.action === 'status') {
    return { jobs: jobs.slice(-10).reverse().map(({ id, title, status, start, updatedAt }) =>
      ({ id, title, status, start, updatedAt })) };
  }
  const updating = args.action === 'update';
  if (!updating && args.action !== 'create') return { error: '未知的日程操作' };
  let expected;
  if (updating) {
    const regular = readStored(dataDir, 'calendar.json', null);
    const requested = readStored(dataDir, calendarReadFile, []).map(item => item.snapshot);
    const snapshots = [regular, ...requested].filter(Boolean).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const event = snapshots.flatMap(snapshot => snapshot.events)
      .find(item => item.eventId && item.eventId === args.eventId && item.start === args.originalStart);
    if (!event || event.allDay) return { error: '请先查到要修改的单次非全天日程，再使用返回的编号和原开始时间' };
    const { eventId, start, end, title, location } = event;
    expected = { eventId, start, end, title, location };
  }
  const title = typeof args.title === 'string' ? args.title.trim() : expected?.title ?? '';
  const location = typeof args.location === 'string' ? args.location.trim() : expected?.location ?? '';
  const start = args.start ?? expected?.start;
  const end = args.end ?? (expected && start + (expected.end - expected.start));
  const now = Date.now();
  if (!title || title.length > 160 || location.length > 100 ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start <= now || end <= start || end - start > 86400000 || end > 8.64e15) {
    return { error: '请提供准确的标题、未来开始时间和结束时间，日程最长 24 小时' };
  }
  const duplicate = jobs.find((job) => job.expected?.eventId === expected?.eventId &&
    job.expected?.start === expected?.start && job.title === title && job.location === location &&
    job.start === start && job.end === end && !['failed', 'expired', 'conflict'].includes(job.status));
  if (duplicate) return { id: duplicate.id, status: duplicate.status };
  const pending = jobs.filter((job) => job.status === 'queued' && job.start > now && now - job.createdAt < 86400000);
  if (pending.length >= 20) return { error: '手机待处理日程队列已满' };
  const last = jobs.filter((job) => !pending.includes(job)).slice(-100);
  const job = { id: randomUUID(), title, location, start, end, createdAt: now, updatedAt: now, status: 'queued',
    ...(expected ? { operation: 'update', expected } : {}) };
  writeStored(dataDir, 'calendar-writes.json', [...last, ...pending, job]);
  return { id: job.id, status: job.status, note: '待手机领取并确认写入，当前尚未写入日历。' };
}
