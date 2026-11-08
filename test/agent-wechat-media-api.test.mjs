import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentWechatApi } from '../src/agent-wechat/api.js';

test('media bytes use only the configured local account endpoint, private bearer and bounded response', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'); const token = 'x'.repeat(40);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const config = () => ({ agentWechat: { endpoint: 'http://127.0.0.1:6174', accountId: 'test', tokenFile } });
  let count = 0;
  const api = new AgentWechatApi(config, async (url, options) => {
    count++;
    assert.equal(url, 'http://127.0.0.1:6174/v1/accounts/test/media/asset_1/content');
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    return count === 1 ? new Response(Buffer.from([1, 2, 3]))
      : new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(12 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1)); controller.close();
      } }));
  });
  assert.deepEqual(await api.request('/media/asset_1/content', { binary: true }), Buffer.from([1, 2, 3]));
  for (const route of ['https://attacker.invalid/media/x/content', '/media/../secrets/content', '/messages/secret'])
    await assert.rejects(api.request(route, { binary: true }), /路径无效/);
  assert.equal(count, 1);
  await assert.rejects(api.request('/media/asset_1/content', { binary: true }), /超过 12 MiB/);
});
