import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
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
