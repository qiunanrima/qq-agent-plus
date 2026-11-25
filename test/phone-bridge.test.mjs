import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRouter } from '../src/console/router.js';
import { registerPhoneBridge, selectPhoneNotifications } from '../src/phone-bridge/index.js';

test('phone upload uses its own credential and stores a retried event only once', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-phone-bridge-'));
  const token = 'a'.repeat(64);
  const previousToken = process.env.QQ_AGENT_PHONE_TOKEN;
  delete process.env.QQ_AGENT_PHONE_TOKEN;
  const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const router = createRouter({ json, authorize: (req) => req.headers.authorization === 'Bearer console' });
  router.add('GET', '/api/console-test', (_, res) => json(res, 200, {}));
  registerPhoneBridge(router, {
    dataDir, json,
    async readBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks));
    }
  });
  const server = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.QQ_AGENT_PHONE_TOKEN;
    else process.env.QQ_AGENT_PHONE_TOKEN = previousToken;
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const id = randomUUID();
  const postedAt = Date.parse('2026-11-25T08:00:00Z');
  const event = { id, source: 'com.tencent.mm', title: 'Example', body: 'Test notification', postedAt };
  const send = (credential, events = [event]) => fetch(base + '/api/phone-bridge/notifications', {
    method: 'POST', headers: { Authorization: 'Bearer ' + credential },
    body: JSON.stringify({ events })
  });
  assert.equal((await send(token)).status, 401);
  await assert.rejects(readFile(join(dataDir, 'phone-bridge', 'inbox.json')), { code: 'ENOENT' });
  process.env.QQ_AGENT_PHONE_TOKEN = token;
  assert.equal((await send('console')).status, 401);
  assert.equal((await fetch(base + '/api/console-test', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await send(token, [{ ...event, body: 'x'.repeat(2049) }])).status, 400);
  const replies = await Promise.all([send(token), send(token)]);
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { accepted: [id] });
  }
  const stored = JSON.parse(await readFile(join(dataDir, 'phone-bridge', 'inbox.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body, event.body);
  assert.equal(stored[0].postedAt, new Date(postedAt).toISOString());
  assert.deepEqual(await (await send(token, [])).json(), { accepted: [] });
  const sync = JSON.parse(await readFile(join(dataDir, 'phone-bridge', 'notification-sync.json'), 'utf8'));
  assert.ok(Date.parse(sync.lastSyncAt) >= Date.parse(stored[0].receivedAt));

  const from = 1795564800000;
  const to = from + 86400000;
  const calendar = (credential, events) => fetch(base + '/api/phone-bridge/calendar', {
    method: 'POST', headers: { Authorization: 'Bearer ' + credential },
    body: JSON.stringify({ from, to, timeZone: 'Asia/Shanghai', events })
  });
  const meeting = { start: from + 10000, end: from + 20000, allDay: false, title: 'Meeting', location: '' };
  assert.equal((await calendar('console', [meeting])).status, 401);
  assert.equal((await calendar(token, [{ ...meeting, end: from }])).status, 400);
  assert.deepEqual(await (await calendar(token, [meeting])).json(), { accepted: 1 });
  assert.deepEqual(await (await calendar(token, [])).json(), { accepted: 0 });
  const snapshot = JSON.parse(await readFile(join(dataDir, 'phone-bridge', 'calendar.json'), 'utf8'));
  assert.equal(snapshot.from, from);
  assert.deepEqual(snapshot.events, []);

  const command = { id: randomUUID(), title: 'Queued meeting', location: '',
    start: Date.now() + 60000, end: Date.now() + 120000, createdAt: Date.now(), status: 'queued' };
  await writeFile(join(dataDir, 'phone-bridge', 'calendar-writes.json'), JSON.stringify([command]));
  const commands = async (ready, results = []) => {
    const reply = await fetch(base + '/api/phone-bridge/calendar', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ mode: 'commands', ready, results })
    });
    assert.equal(reply.status, 200);
    return reply.json();
  };
  assert.equal((await commands(false)).command, null);
  const claims = await Promise.all([commands(true), commands(true)]);
  assert.deepEqual(claims.map((item) => item.command?.id).filter(Boolean), [command.id]);
  assert.equal((await commands(true)).command, null);
  const result = { id: command.id, status: 'written' };
  assert.deepEqual((await commands(false, [result])).acknowledged, [command.id]);
  assert.deepEqual((await commands(false, [result])).acknowledged, [command.id]);
  assert.equal((await commands(true)).command, null);
});

test('phone notification results filter by app, keyword and half-open time range before limiting', () => {
  const since = Date.parse('2026-11-25T08:00:00Z');
  const event = (source, body, delta) => ({ source, title: '标题', body, receivedAt: new Date(since + delta).toISOString() });
  const first = event('com.tencent.mm', 'Sprint A', 0);
  const second = event('com.tencent.mm', 'sprint B', 1);
  const latest = event('com.tencent.mobileqq', 'Sprint C', 2);
  const result = selectPhoneNotifications([first, second, latest], {
    app: '微信', query: 'SPRINT', since, until: since + 2, limit: 1
  });
  assert.deepEqual(result, {
    events: [second], matched: 2, byApp: [{ source: 'com.tencent.mm', count: 2 }],
    truncated: true, lastReceivedAt: latest.receivedAt
  });
  assert.deepEqual(selectPhoneNotifications([first, second, latest], { until: since + 1 }).events, [first]);
  const lateUpload = { ...latest, postedAt: new Date(since - 1).toISOString() };
  assert.deepEqual(selectPhoneNotifications([first, second, lateUpload], { since }).events, [second, first]);
  assert.ok(selectPhoneNotifications([], { since, until: since }).error);
});
