import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkMailFollowUp, formatMailFollowUpReminder, manageMailFollowUp } from '../src/personal-mail/follow-up.js';

test('follow-up handoff keeps the source and uses the remaining space for reply details', () => {
  const text = formatMailFollowUpReminder({ threadId: 'quoted', outcome: {
    status: 'replied', text: '答'.repeat(65) + '报价 120 元，周五交付。' + '尾'.repeat(200)
  } });
  assert.ok(text.length <= 200);
  assert.match(text, /报价 120 元，周五交付/);
  assert.match(text, /https:\/\/mail.google.com\/mail\/u\/0\/#all\/quoted$/);
});

test('follow-up reports replies before the deadline and hands off a due outcome once', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-follow-up-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const env = { QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' };
  const options = { dataDir, env, now: 100 };
  const add = (threadId, deadline) => manageMailFollowUp({ threadId, deadline }, options);
  const first = add('quoted', 500);
  const second = add('waiting', 600);
  const third = add('another', 601);
  assert.deepEqual(add('quoted', 1000), {
    id: first.id, status: 'pending', deadline: 500, alreadyScheduled: true,
    source: 'https://mail.google.com/mail/u/0/#all/quoted'
  });
  const calls = [];
  const readThread = async ({ threadId }) => ({ status: 'ok', messages: [
    { direction: 'outgoing', subject: 'Request' },
    { direction: 'incoming', automatic: true, excerpt: 'Out of office' },
    ...(threadId === 'quoted' ? [{ direction: 'incoming', excerpt: 'Quote is ready' }] : [])
  ] });
  const check = (now, notify = job => calls.push(job)) => checkMailFollowUp({ dataDir, env, readThread, notify, now });
  await check(200);
  await check(200);
  assert.equal(calls[0].outcome.status, 'replied');
  assert.equal(calls.length, 1);
  await assert.rejects(check(600, () => { throw new Error('temporary queue failure'); }), /queue failure/);
  await check(601);
  await check(602);
  await check(600 + 180000);
  assert.deepEqual(calls.map(job => [job.id, job.outcome.status]),
    [[first.id, 'replied'], [third.id, 'due'], [second.id, 'due']]);
});

test('a transient deadline failure can recover without sending an unverified reminder', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-follow-up-retry-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const env = { QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' };
  const deadline = 10_000;
  manageMailFollowUp({ threadId: 'recover', deadline }, { dataDir, env, now: 1 });
  const outcomes = [];
  let reads = 0;
  const check = now => checkMailFollowUp({ dataDir, env, now, notify: job => outcomes.push(job.outcome.status),
    readThread: async () => ++reads === 1 ? { status: 'unavailable' } :
      { status: 'ok', messages: [{ direction: 'outgoing', subject: 'Quote' }] } });
  await check(deadline);
  await check(deadline + 1);
  assert.equal(reads, 1);
  assert.deepEqual(outcomes, []);
  await check(deadline + 600_000);
  assert.deepEqual(outcomes, ['due']);
});

test('changing the deadline while Gmail is being read prevents an obsolete deadline reminder', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-follow-up-reschedule-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const env = { QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' };
  const job = manageMailFollowUp({ threadId: 'quote', deadline: 100 }, { dataDir, env, now: 1 });
  const reschedule = manageMailFollowUp;
  const outcomes = [];
  const readThread = async () => ({ status: 'ok', messages: [{ direction: 'outgoing', subject: 'Quote' }] });
  const notify = item => outcomes.push(item.outcome.status);
  await checkMailFollowUp({ dataDir, env, now: 100, notify, readThread: async () => {
    const changed = reschedule({ action: 'follow_up_reschedule', followUpId: job.id, deadline: 200 },
      { dataDir, env, now: 100 });
    assert.equal(changed.id, job.id);
    return readThread();
  } });
  assert.deepEqual(outcomes, []);
  await checkMailFollowUp({ dataDir, env, now: 200, notify, readThread });
  assert.deepEqual(outcomes, ['due']);
});


test('listing follow-ups keeps pending jobs visible ahead of recent history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-follow-up-list-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const options = { dataDir, env: { QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' }, now: 1 };
  const run = args => manageMailFollowUp(args, options);
  run({ action: 'follow_up_create', threadId: 'later', deadline: 200 });
  run({ action: 'follow_up_create', threadId: 'sooner', deadline: 100 });
  for (let index = 0; index < 21; index += 1) {
    const job = run({ action: 'follow_up_create', threadId: 'old' + index, deadline: 50 });
    run({ action: 'follow_up_cancel', followUpId: job.id });
  }
  const { jobs } = run({ action: 'follow_up_list' });
  assert.equal(jobs.length, 20);
  assert.deepEqual(jobs.slice(0, 2).map(job => job.threadId), ['sooner', 'later']);
  assert.equal(jobs[0].source, 'https://mail.google.com/mail/u/0/#all/sooner');
  assert.equal(jobs[2].threadId, 'old20');
});
