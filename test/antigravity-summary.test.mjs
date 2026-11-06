import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureCliSummary } from '../src/antigravity-cli/summary.js';
test('CLI completion without finish retains factual summary without another model call', () => {
  const session = { sent: ['one'] };
  ensureCliSummary(session, [{ eventKind: 'message', text: '你好' }], '你好呀');
  assert.match(session.handoffDraft.summary, /你好.*你好呀/);
  assert.ok(session.episodeSummary); assert.ok(session.finishReason);
  assert.equal(session.summarySource, 'host-fallback');
});
test('explicit summaries and clear-handoff intent are preserved', () => {
  const existing = { handoffDraft: { summary: '原总结' } };
  ensureCliSummary(existing, [], 'other'); assert.equal(existing.handoffDraft.summary, '原总结');
  const cleared = { handoffDraft: { clearHandoff: true }, sent: [] };
  ensureCliSummary(cleared, [], ''); assert.equal(cleared.handoffDraft.clearHandoff, true);
  assert.match(cleared.handoffDraft.summary, /未发送/);
});
