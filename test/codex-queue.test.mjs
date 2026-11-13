import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexQueue } from '../src/codex-cli/queue.js';
const options = { limit: 1, isEnabled: () => true };

test('Codex queues requests FIFO with one active turn per chat and releases slots exactly once', async () => {
  const queue = createCodexQueue();
  const first = await queue.acquire({ ...options, chatKey: 'a' });
  const order = [];
  const second = queue.acquire({ ...options, chatKey: 'b' }).then(release => { order.push('b'); return release; });
  const third = queue.acquire({ ...options, chatKey: 'c' }).then(release => { order.push('c'); return release; });
  assert.deepEqual(queue.status(), { active: 1, queued: 2 });
  first(); const releaseSecond = await second; first();
  assert.deepEqual(order, ['b']); releaseSecond(); (await third)();
  assert.deepEqual(order, ['b', 'c']); assert.deepEqual(queue.status(), { active: 0, queued: 0 });
  const release = await queue.acquire({ ...options, limit: 2, chatKey: 'same' });
  const same = queue.acquire({ ...options, limit: 2, chatKey: 'same' });
  assert.deepEqual(queue.status(), { active: 1, queued: 1 }); release(); (await same)();
});

test('Codex queued cancellation, disable, deadline and full queue never acquire a worker', async () => {
  const queue = createCodexQueue({ maxWaiting: 1, waitMs: 20 });
  const release = await queue.acquire(options);
  const pending = queue.acquire(options);
  await assert.rejects(queue.acquire(options), e => e.code === 'CODEX_NO_RETRY' && /queue full/.test(e.message));
  await assert.rejects(pending, /wait timed out/);
  const controller = new AbortController();
  const cancelled = queue.acquire({ ...options, signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(queue.acquire({ ...options, isEnabled: () => false }), /cancelled/);
  const stopped = queue.acquire(options); queue.cancelWaiting(); await assert.rejects(stopped, /cancelled/);
  release(); assert.deepEqual(queue.status(), { active: 0, queued: 0 });
});

test('Codex shutdown cancels all waiting requests without admitting a request behind the blocked chat', async () => {
  const queue = createCodexQueue();
  const release = await queue.acquire({ ...options, limit: 2, chatKey: 'a' });
  const blocked = queue.acquire({ ...options, limit: 2, chatKey: 'a' });
  const next = queue.acquire({ ...options, limit: 2, chatKey: 'b' });
  queue.cancelWaiting();
  await assert.rejects(blocked, /cancelled/); await assert.rejects(next, /cancelled/);
  assert.deepEqual(queue.status(), { active: 1, queued: 0 }); release();
});

test('disabling Codex while queued cancels before admission', async () => {
  const queue = createCodexQueue({ waitMs: 1000 });
  const release = await queue.acquire(options);
  let enabled = true;
  const pending = queue.acquire({ ...options, isEnabled: () => enabled });
  enabled = false;
  await assert.rejects(pending, /cancelled/); release();
  assert.deepEqual(queue.status(), { active: 0, queued: 0 });
});
