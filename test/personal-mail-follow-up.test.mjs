import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkMailFollowUp, manageMailFollowUp } from '../src/personal-mail/follow-up.js';

test('follow-up reports replies before the deadline and hands off a due outcome once', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-follow-up-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 3 }));
  const env = { QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' };
  const options = { dataDir, env, now: 100 };
  const add = (threadId, deadline) => manageMailFollowUp({ threadId, deadline }, options);
  const first = add('quoted', 500);
  const second = add('waiting', 600);
  assert.equal(add('quoted', 1000).id, first.id);
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
  assert.deepEqual(calls.map(job => [job.id, job.outcome.status]), [[first.id, 'replied'], [second.id, 'due']]);
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
