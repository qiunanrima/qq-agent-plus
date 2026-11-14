import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promptImageMessageIds, preparePromptImages } from '../src/antigravity-cli/prompt-images.js';
import { prepareMcpInvocation } from '../src/antigravity-cli/mcp-invocation.js';
import { listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
test('preload only incoming or explicitly quoted images, bounded to two messages', () => {
  const quoted = { mid: -12, media: [{ kind: 'image' }] };
  const entries = [{ mid: 1, media: [] }, { mid: 2, media: [{ kind: 'image' }] },
    { mid: 3, reply: { messageId: -12 } }];
  assert.deepEqual(promptImageMessageIds(entries, mid => mid === -12 ? quoted : null), ['2', '-12']);
  assert.deepEqual(promptImageMessageIds([{ mid: 4, media: [{ kind: 'audio' }] }], () => null), []);
});

test('ACP attachments contain actual image bytes; failed and remote images are never claimed visible', async () => {
  const result = await preparePromptImages(['1', '1', '2'], async id => id === '1'
    ? { content: [image] } : { isError: true, content: [image, { type: 'text', text: 'download failed' }] });
  assert.deepEqual(result.filter(part => part.type === 'image'), [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }]);
  assert.ok(result.some(part => part.text === 'download failed'));
  const remote = await preparePromptImages(['1'], async () => ({ content: [{ type: 'image_url', image_url: { url: 'http://localhost/private' } }] }));
  assert.equal(remote.some(part => part.type === 'image'), false);
  const large = await preparePromptImages(['1'], async () => ({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') } }] }));
  assert.equal(large.some(part => part.type === 'image'), false);
  assert.match(large.at(-1).text, /未传入模型/);
});

test('preloading respects QQ approval, cancellation, tool selection and shared call budget without replay', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-prompt-image-'));
  const controller = new AbortController();
  const config = { workspace, agent: 'qq-mcp', nativeApproval: true, qqApproval: true, maxToolCalls: 1, timeoutMs: 3000 };
  let calls = 0;
  const options = { config, signal: controller.signal,
    tools: [{ function: { name: 'get_message_images', parameters: { type: 'object' } } }],
    mcpRun: { chatKey: 'private:1', runId: 'preload-approval', allowed: () => true, imageMessageIds: ['1'],
      execute: async () => { calls++; return { content: [image] }; } } };
  const invocation = await prepareMcpInvocation(options);
  try {
    const pending = invocation.promptImages(controller.signal);
    for (let i = 0; i < 50 && !listCliApprovals().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 0);
    const approval = listCliApprovals()[0]; assert.ok(approval);
    decideCliApproval(approval.id, true);
    const parts = await pending;
    assert.equal(parts.filter(part => part.type === 'image').length, 1);
    assert.equal(calls, 1); assert.equal(invocation.calls(), 1);
    assert.deepEqual(await invocation.promptImages(controller.signal), parts);
    assert.equal(calls, 1);
    const noTools = await prepareMcpInvocation({ ...options, toolChoice: 'none' });
    try { assert.deepEqual(await noTools.promptImages(controller.signal), []); } finally { await noTools.close(); }
  } finally { controller.abort(); await invocation.close(); await fs.rm(workspace, { recursive: true, force: true }); }
});
