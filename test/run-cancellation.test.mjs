import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCancelled, isIntentionalCancellation } from '../src/core/run-cancellation.js';

test('host pause and shutdown cancellation survive wrapped CLI errors', () => {
  const controller = new AbortController(); controller.abort(runCancelled('paused'));
  assert.equal(isIntentionalCancellation(new Error('Antigravity request failed: Run cancelled'), controller.signal), true);
  assert.equal(isIntentionalCancellation(new Error('wrapper', { cause: runCancelled('shutdown') })), true);
});
test('timeouts and a remote cancellation-shaped message remain errors', () => {
  const controller = new AbortController(); controller.abort(new Error('Run deadline exceeded'));
  assert.equal(isIntentionalCancellation(new Error('Run cancelled'), controller.signal), false);
  assert.equal(isIntentionalCancellation(new Error('Run cancelled')), false);
});
