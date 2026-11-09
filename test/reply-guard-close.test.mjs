import test from 'node:test';
import assert from 'node:assert/strict';
import { isAcknowledgedClose } from '../src/core/reply-guard-close.js';
const silent = { messages: [{ toolCall: { name: 'finish', isError: false } }] };
test('successful silent finish after a short acknowledgement is not a processing failure', () => {
  for (const text of ['欧克', '好喔', '好的。', 'OK!', '收到', '晚安']) assert.equal(isAcknowledgedClose(silent, [{ text }]), true);
});
test('questions, media, failed tools and missing finish retain reply protection', () => {
  for (const text of ['好？', '可以吗', '好，几点开始', '为什么', '']) assert.equal(isAcknowledgedClose(silent, [{ text }]), false);
  assert.equal(isAcknowledgedClose(silent, [{ text: '好', media: [{}] }]), false);
  assert.equal(isAcknowledgedClose(silent, [{ text: '好' }, { text: '怎么办' }]), false);
  for (const session of [{ messages: [] }, { ...silent, error: 'timeout' }, { messages: [...silent.messages, { toolCall: { isError: true } }] }, { messages: [...silent.messages, { role: 'assistant', content: 'internal draft' }] }])
    assert.equal(isAcknowledgedClose(session, [{ text: '好' }]), false);
});

test('replayed approval commands may finish silently but questions and failures still require protection', () => {
  for (const text of ['同意 ap_mw9e1m64_rvxsfq', '批准 ap_test 5', '拒绝 CLI 11111111-2222-3333-4444-555555555555']) {
    assert.equal(isAcknowledgedClose(silent, [{ text }]), true);
    assert.equal(isAcknowledgedClose({ ...silent, error: 'timeout' }, [{ text }]), false);
  }
  for (const text of ['同意 ap_test 后怎么办', '同意 ap_test？', '批准所有操作']) assert.equal(isAcknowledgedClose(silent, [{ text }]), false);
});
