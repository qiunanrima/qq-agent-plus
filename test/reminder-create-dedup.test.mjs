// All reminders and identities are synthetic; no model or OneBot calls are made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-remind-dedup-'));
process.env.QQ_AGENT_DATA_DIR = path.join(dir, 'data');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { ReminderStore } = await import('../src/core/reminders.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const BASE = Date.parse('2026-10-29T12:00:00Z');
const daily = { kind: 'daily', hour: 9, minute: 0 };
const weekly = { kind: 'weekly', weekday: 1, hour: 9, minute: 0 };
const cron = { kind: 'cron', cron: '0 9 * * 1-5' };
let cfg;
let serial = 0;

beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call'); });
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.reminders.enabled = true;
  cfg.reminders.quiet = null;
  setRuntimeConfig(cfg);
});

function fixture() {
  const file = path.join(dir, `reminders-${serial++}.json`);
  const store = new ReminderStore(file);
  const ctx = {
    chatKey: 'private:1', reminders: store,
    session: { leaseId: 'synthetic-run', sent: [] },
    triggerEntries: [
      { senderId: '1', senderName: 'Requester A' },
      { senderId: '2', senderName: 'Requester B' }
    ]
  };
  return { file, store, ctx };
}

const request = (repeat = daily) => ({
  action: 'add', text: 'Synthetic reminder', repeat, from: 'Requester A', to: 'Target A'
});

async function call(ctx, args) {
  const result = await executeTool(buildToolDefs(), ctx, 'remind', JSON.stringify(args));
  assert.equal(result.isError, undefined, String(result.content));
  return JSON.parse(result.content);
}

for (const [name, first, second] of [
  ['daily', request(), request()],
  ['weekly', request(weekly), request(weekly)],
  ['cron', request(cron), request(cron)],
  ['default minute and timezone', request({ kind: 'daily', hour: 9 }), request({ ...daily, tz: 'Asia/Shanghai', jitterMs: 0 })],
  ['legacy daily', request('daily'), request(daily)],
  ['legacy weekly', request('weekly:1'), request(weekly)],
  ['absolute clock spelling', { ...request(), at: '9：00' }, { ...request(), at: '09:00' }]
]) {
  test(`remind reuses an identical recurring request: ${name}`, async () => {
    const { ctx, store, file } = fixture();
    const a = await call(ctx, first);
    const saved = fs.readFileSync(file, 'utf8');
    const b = await call(ctx, second);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.reused, true);
    assert.equal(b.id, a.id);
    assert.equal(b.at, a.at);
    assert.equal(store.list(ctx.chatKey).length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), saved, 'reuse must not write or re-arm the task');
  });
}

test('relative first delay is compared as a request, not recalculated milliseconds', async (t) => {
  const { ctx, store } = fixture();
  const a = await call(ctx, { ...request(), minutes: 60 });
  t.mock.timers.tick(1500);
  const b = await call(ctx, { ...request(), minutes: 60 });
  assert.equal(b.id, a.id);
  assert.equal(b.at, a.at);
  assert.equal(store.items.length, 1);
});

test('concurrent identical tool calls create only one recurring series', async () => {
  const { ctx, store } = fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () => call(ctx, request())));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(store.items.length, 1);
});

test('random first-occurrence jitter does not create another recurring series', async (t) => {
  const { ctx, store } = fixture();
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  const args = request({ ...daily, jitterMs: 600000 });
  const a = await call(ctx, args);
  random = 0.9;
  const b = await call(ctx, args);
  assert.equal(b.id, a.id);
  assert.equal(b.at, a.at);
  assert.equal(store.items.length, 1);
});

test('reuse succeeds at capacity without granting another task slot', async () => {
  const { ctx, store } = fixture();
  for (let i = 0; i < 9; i++) await call(ctx, { ...request(), text: `Synthetic distinct ${i}` });
  const a = await call(ctx, request());
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.equal(b.reused, true);
  assert.equal(store.items.length, 10);
  const extra = await executeTool(buildToolDefs(), ctx, 'remind', JSON.stringify({ ...request(), text: 'Synthetic extra' }));
  assert.equal(extra.isError, true);
  assert.match(extra.content, /上限/);
});

test('reloading storage within the same context still finds the original pending task', async () => {
  const { ctx, file } = fixture();
  const a = await call(ctx, request());
  ctx.reminders = new ReminderStore(file);
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.equal(ctx.reminders.items.length, 1);
});

for (const [name, alter] of [
  ['body', (args) => { args.text = 'Synthetic other reminder'; }],
  ['requester', (args) => { args.from = 'Requester B'; }],
  ['target', (args) => { args.to = 'Target B'; }],
  ['hour', (args) => { args.repeat.hour = 10; }],
  ['timezone', (args) => { args.repeat.tz = 'UTC'; }],
  ['jitter', (args) => { args.repeat.jitterMs = 300000; }],
  ['first delay', (args) => { args.minutes = 120; }],
  ['explicit first clock', (args) => { args.at = '09:00'; }],
  ['quiet config', () => { cfg.reminders.quiet = { start: '23:00', end: '07:00' }; }],
  ['chat', (_args, ctx) => { ctx.chatKey = 'private:2'; }]
]) {
  test(`independent request stays separate when changing ${name}`, async () => {
    const { ctx, store } = fixture();
    const a = await call(ctx, request());
    const args = structuredClone(request());
    alter(args, ctx);
    const b = await call(ctx, args);
    assert.notEqual(b.id, a.id);
    assert.equal(b.created, true);
    assert.equal(store.items.length, 2);
  });
}

test('unverified requester text is not collapsed into the same empty attribution', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, { ...request(), from: 'Unverified A' });
  const b = await call(ctx, { ...request(), from: 'Unverified B' });
  assert.notEqual(b.id, a.id);
  assert.ok(store.items.every(item => item.createdBy === ''));
});

test('an unverified requester is not deduplicated even when its text repeats', async () => {
  const { ctx, store } = fixture();
  const args = { ...request(), from: 'Unverified requester' };
  const a = await call(ctx, args);
  const b = await call(ctx, args);
  assert.notEqual(a.id, b.id);
  assert.equal(store.items.length, 2);
});

test('a batch from multiple people without explicit attribution stays separate', async () => {
  const { ctx, store } = fixture();
  const args = { ...request(), from: '' };
  const a = await call(ctx, args);
  const b = await call(ctx, args);
  assert.notEqual(a.id, b.id);
  assert.equal(store.items.length, 2);
});

test('matching the same nickname for different people does not merge their requests', async () => {
  const { ctx, store } = fixture();
  ctx.triggerEntries = ctx.triggerEntries.map(entry => ({ ...entry, senderName: 'Shared name' }));
  const args = { ...request(), from: 'Shared name' };
  const a = await call(ctx, args);
  const b = await call(ctx, args);
  assert.notEqual(a.id, b.id);
  assert.equal(store.items.length, 2);
});

for (const count of [0, 1]) {
  test(`a request without from can reuse within a context with ${count} human sender`, async () => {
    const { ctx, store } = fixture();
    ctx.triggerEntries = ctx.triggerEntries.slice(0, count);
    const args = { ...request(), from: '' };
    const a = await call(ctx, args);
    const b = await call(ctx, args);
    assert.equal(b.id, a.id);
    assert.equal(b.reused, true);
    assert.equal(store.items.length, 1);
    assert.equal(store.items[0].createdBy, '', 'deduplication must not invent attribution');
  });
}

test('a new tool context is independent even when a session object is retained', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  const b = await call({ ...ctx }, request());
  assert.notEqual(b.id, a.id);
  assert.equal(store.items.length, 2);
});

test('an existing task from another context is not deduplicated globally', async () => {
  const { ctx, store } = fixture();
  await call({ ...ctx }, request());
  const a = await call(ctx, request());
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.equal(store.items.length, 2);
});

test('one-off reminders retain their existing independent creation behavior', async () => {
  const { ctx, store } = fixture();
  const args = { action: 'add', text: 'Synthetic one-off', minutes: 60 };
  const a = await call(ctx, args);
  const b = await call(ctx, args);
  assert.notEqual(b.id, a.id);
  assert.equal(store.items.length, 2);
});

test('canceling the reused ID cancels the only series and allows a fresh creation', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  const b = await call(ctx, request());
  await call(ctx, { action: 'cancel', id: b.id });
  assert.equal(store.list(ctx.chatKey).length, 0);
  const c = await call(ctx, request());
  assert.notEqual(c.id, a.id);
  const d = await call(ctx, request());
  assert.equal(d.id, c.id);
  assert.equal(store.list(ctx.chatKey).length, 1);
});

test('failed delivery is not revived or rewritten by a cached creation', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  store.failDelivery(a.id, 'Synthetic unknown delivery');
  const saved = structuredClone(store.items[0]);
  const b = await call(ctx, request());
  assert.notEqual(b.id, a.id, 'retain the existing add behavior for a non-pending task');
  assert.deepEqual(store.items[0], saved, 'creation must not revive or send the failed task');
});

test('a reused re-armed series reports its current next occurrence', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  store.markFired(a.id);
  const saved = fs.readFileSync(store.file, 'utf8');
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.notEqual(b.at, a.at);
  assert.equal(fs.readFileSync(store.file, 'utf8'), saved);
});

test('a task with changed content is not returned as an identical creation', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  store.items[0].text = 'Synthetic externally changed content';
  const b = await call(ctx, request());
  assert.notEqual(b.id, a.id);
  assert.equal(store.items[0].text, 'Synthetic externally changed content');
});

test('a deferred series is reused without moving its stored trigger time again', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  const deferredAt = store.items[0].at + 3600000;
  store.deferTo(a.id, deferredAt);
  const saved = fs.readFileSync(store.file, 'utf8');
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.notEqual(b.at, a.at);
  assert.equal(store.items[0].at, deferredAt);
  assert.equal(fs.readFileSync(store.file, 'utf8'), saved);
});

test('a missing original task is not returned from the run cache', async () => {
  const { ctx, store } = fixture();
  const a = await call(ctx, request());
  store.items = [];
  const b = await call(ctx, request());
  assert.notEqual(b.id, a.id);
  assert.equal(store.items.length, 1);
});

test('invalid repeat with an explicit first time cannot reuse an earlier success', async () => {
  const { ctx, store } = fixture();
  await call(ctx, { ...request(), at: '09:00' });
  const bad = await executeTool(buildToolDefs(), ctx, 'remind', JSON.stringify({
    ...request(), at: '09:00', repeat: { ...daily, hour: 25 }
  }));
  assert.equal(bad.isError, true);
  assert.equal(store.items.length, 1);
});

test('disabled reminders and invalid parameters are checked before reuse', async () => {
  const { ctx, store } = fixture();
  await call(ctx, request());
  const defs = buildToolDefs();
  cfg.reminders.enabled = false;
  const disabled = await executeTool(defs, ctx, 'remind', JSON.stringify(request()));
  assert.equal(disabled.isError, true);
  cfg.reminders.enabled = true;
  for (const args of [
    { ...request(), repeat: { kind: 'daily', hour: 25 } },
    { ...request(), at: 'bad' },
    { ...request(), minutes: 0 },
    { ...request(), text: '' }
  ]) {
    const bad = await executeTool(defs, ctx, 'remind', JSON.stringify(args));
    assert.equal(bad.isError, true);
  }
  assert.equal(store.items.length, 1);
});

test('a rejected creation is not cached and can succeed when capacity is freed', async () => {
  const { ctx, store } = fixture();
  for (let i = 0; i < 10; i++) await call(ctx, { ...request(), text: `Synthetic occupied ${i}` });
  const bad = await executeTool(buildToolDefs(), ctx, 'remind', JSON.stringify(request()));
  assert.equal(bad.isError, true);
  store.cancel({ chatKey: ctx.chatKey });
  const a = await call(ctx, request());
  const b = await call(ctx, request());
  assert.equal(b.id, a.id);
  assert.equal(store.items.length, 11);
  assert.equal(store.list(ctx.chatKey).length, 10);
});

test('一次性跨周提醒经过正常工具入口改期、查询与取消', async () => {
  const { ctx, store } = fixture();
  ctx.agreementHistory = () => [{ id: 'test-goal', status: 'open' }];
  const { id } = await call(ctx, { action: 'add', text: '开黑', agreementId: 'test-goal',
    dateTime: '2026-11-06 19:30', eventTime: '2026-11-06 20:00' });
  await call(ctx, { action: 'reschedule', id, dateTime: '2026-11-07 19:30', eventTime: '2026-11-07 20:00' });
  const current = store.list(ctx.chatKey)[0];
  assert.equal(current.goalId, 'test-goal');
  assert.equal(current.eventAt - current.at, 1800000);
  await call(ctx, { action: 'cancel', id });
  const result = await call(ctx, { action: 'history' });
  assert.equal(result.reminders[0].id, id);
  assert.equal(result.reminders[0].status, 'canceled');
  assert.equal(result.reminders[0].revisions.length, 1);
});
