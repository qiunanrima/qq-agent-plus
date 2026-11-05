import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCliFinishRecovery } from '../src/antigravity-cli/finish-recovery.js';

test('known OCR failure can finish only after a visible reply and explicit acknowledgement', () => {
  const recovery = createCliFinishRecovery();
  recovery.observe('read_image_text', { isError: true });
  recovery.observe('send_message', { content: 'sent' });
  assert.equal(recovery.canAcknowledge({}, { visibleReply: true }), false);
  assert.equal(recovery.canAcknowledge({ errorAcknowledged: true }), false);
  assert.equal(recovery.canAcknowledge({ errorAcknowledged: true }, { visibleReply: true, uncertain: true }), false);
  recovery.observe('finish', { isError: true }, true);
  assert.equal(recovery.canAcknowledge({ errorAcknowledged: true }, { visibleReply: true }), true);
});

test('failed or partial writes and unknown tools remain blocking even after later successful sends', () => {
  for (const [name, result] of [['send_message', { isError: true }], ['send_message', { partialFailure: true }], ['plugin_write', { isError: true }]]) {
    const recovery = createCliFinishRecovery();
    recovery.observe('read_image_text', { isError: true }); recovery.observe(name, result);
    recovery.observe('send_message', { content: 'sent' });
    assert.equal(recovery.canAcknowledge({ errorAcknowledged: true }, { visibleReply: true }), false);
  }
});
