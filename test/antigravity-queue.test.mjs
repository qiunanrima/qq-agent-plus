import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCliQueue } from '../src/antigravity-cli/queue.js';

const options = { limit: 1, isEnabled: () => true };
test('FIFO queues different conversations without starting extra workers', async () => {
  const q = createCliQueue();
  const first = await q.acquire({ ...options, chatKey: 'private:1' });
  const order = [];
  const second = q.acquire({ ...options, chatKey: 'group:2' }).then(release => { order.push(2); return release; });
  const third = q.acquire({ ...options, chatKey: 'private:3' }).then(release => { order.push(3); return release; });
  assert.deepEqual(q.status(), { active: 1, queued: 2 });
  first(); const endSecond = await second; assert.deepEqual(order, [2]);
  endSecond(); (await third)(); assert.deepEqual(order, [2, 3]);
  first(); assert.deepEqual(q.status(), { active: 0, queued: 0 });
});
test('cancelled queued work never acquires a slot', async () => {
  const q = createCliQueue(); const release = await q.acquire(options);
  const controller = new AbortController();
  const pending = q.acquire({ ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancelled/);
  release(); assert.deepEqual(q.status(), { active: 0, queued: 0 });
});
test('queue wait has a deadline and disabled work is rejected', async () => {
  const q = createCliQueue({ waitMs: 15 }); const release = await q.acquire(options);
  await assert.rejects(q.acquire(options), /wait timed out/); release();
  await assert.rejects(q.acquire({ ...options, isEnabled: () => false }), /cancelled/);
});
test('same conversation cannot run concurrently even with two slots', async () => {
  const q = createCliQueue(); const o = { ...options, limit: 2, chatKey: 'group:1' };
  const release = await q.acquire(o); const pending = q.acquire(o);
  assert.deepEqual(q.status(), { active: 1, queued: 1 });
  release(); (await pending)();
});
