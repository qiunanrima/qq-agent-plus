import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRouter } from '../src/console/router.js';
import { registerPhoneBridge } from '../src/phone-bridge/index.js';

test('phone upload uses its own credential and stores a retried event only once', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-phone-bridge-'));
  const token = 'a'.repeat(64);
  const previousToken = process.env.QQ_AGENT_PHONE_TOKEN;
  delete process.env.QQ_AGENT_PHONE_TOKEN;
  const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const router = createRouter({ json, authorize: (req) => req.headers.authorization === 'Bearer console' });
  router.add('GET', '/api/console-test', (_, res) => json(res, 200, {}));
  registerPhoneBridge(router, {
    dataDir, json,
    async readBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks));
    }
  });
  const server = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.QQ_AGENT_PHONE_TOKEN;
    else process.env.QQ_AGENT_PHONE_TOKEN = previousToken;
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const id = randomUUID();
  const event = { id, source: 'com.tencent.mm', title: 'Example', body: 'Test notification' };
  const send = (credential, events = [event]) => fetch(base + '/api/phone-bridge/notifications', {
    method: 'POST', headers: { Authorization: 'Bearer ' + credential },
    body: JSON.stringify({ events })
  });
  assert.equal((await send(token)).status, 401);
  await assert.rejects(readFile(join(dataDir, 'phone-bridge', 'inbox.json')), { code: 'ENOENT' });
  process.env.QQ_AGENT_PHONE_TOKEN = token;
  assert.equal((await send('console')).status, 401);
  assert.equal((await fetch(base + '/api/console-test', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await send(token, [{ ...event, body: 'x'.repeat(2049) }])).status, 400);
  const replies = await Promise.all([send(token), send(token)]);
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { accepted: [id] });
  }
  const stored = JSON.parse(await readFile(join(dataDir, 'phone-bridge', 'inbox.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body, event.body);
});
