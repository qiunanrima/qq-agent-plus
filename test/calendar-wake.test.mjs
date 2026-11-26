import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sendCalendarWake } from '../src/phone-bridge/calendar-wake.js';

test('Mi Push sends only a signed wake hint to the configured device', async () => {
  const now = 1795651000000;
  const token = 'a'.repeat(64);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ code: 0 });
  };
  await sendCalendarWake({ env: {}, fetchImpl, now });
  assert.equal(requests.length, 0);
  const env = { QQ_AGENT_PHONE_TOKEN: token, QQ_AGENT_MI_PUSH_SECRET: 'test-secret', QQ_AGENT_MI_PUSH_REG_ID: 'test-registration' };
  await sendCalendarWake({ env, fetchImpl, now });
  await sendCalendarWake({ env, fetchImpl, now: now + 1000 });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, 'https://api.xmpush.xiaomi.com/v3/message/regid');
  assert.equal(options.headers.Authorization, 'key=test-secret');
  const body = options.body;
  assert.equal(body.get('registration_id'), 'test-registration');
  assert.equal(body.get('restricted_package_name'), 'local.assistant.bridge');
  assert.equal(body.get('title'), 'Agent 日程唤醒');
  assert.equal(body.get('description'), now + '.' +
    createHmac('sha256', token).update('calendar-wake-v1:' + now).digest('hex'));
  assert.equal(body.get('payload'), 'calendar-wake-v1');
  assert.ok(!body.toString().includes(token));
});

test('QQ calendar wake is opt-in and coalesces multiple queued reads', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'calendar-qq-wake-'));
  const originalEnv = { ...process.env };
  t.after(async () => {
    for (const key of ['QQ_AGENT_DATA_DIR', 'QQ_AGENT_PHONE_TOKEN', 'QQ_AGENT_QQ_CALENDAR_WAKE',
      'QQ_AGENT_MI_PUSH_SECRET', 'QQ_AGENT_MI_PUSH_REG_ID']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  process.env.QQ_AGENT_DATA_DIR = dataDir;
  process.env.QQ_AGENT_PHONE_TOKEN = 'a'.repeat(64);
  delete process.env.QQ_AGENT_QQ_CALENDAR_WAKE;
  delete process.env.QQ_AGENT_MI_PUSH_SECRET;
  delete process.env.QQ_AGENT_MI_PUSH_REG_ID;
  const { registerPhoneBridge, requestPhoneCalendar } = await import('../src/phone-bridge/index.js');
  const sent = [];
  registerPhoneBridge({ add() {} }, { wakeThroughQq: hint => sent.push(hint) });
  const queue = from => requestPhoneCalendar(dataDir, { from, to: from + 60_000 });
  assert.equal(queue(1_000_000).requestedSync, 'pending');
  await Promise.resolve();
  assert.deepEqual(sent, []);
  process.env.QQ_AGENT_QQ_CALENDAR_WAKE = '1';
  assert.equal(queue(1_100_000).requestedSync, 'pending');
  assert.equal(queue(1_200_000).requestedSync, 'pending');
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Agent 日程唤醒 \d{13}\.[a-f0-9]{64}$/);
});
