import { createHmac } from 'node:crypto';

const title = 'Agent 日程唤醒';
const endpoint = 'https://api.xmpush.xiaomi.com/v3/message/regid';
const packageName = 'local.assistant.bridge';
let lastAttempt = 0;

export function calendarWakeHint(token, timestamp) {
  const content = 'calendar-wake-v1:' + timestamp;
  return timestamp + '.' + createHmac('sha256', token).update(content).digest('hex');
}

export function sendCalendarWake({ env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const token = env.QQ_AGENT_PHONE_TOKEN;
  const secret = env.QQ_AGENT_MI_PUSH_SECRET;
  const registration = env.QQ_AGENT_MI_PUSH_REG_ID;
  if (!/^[a-f0-9]{64}$/i.test(token ?? '') || !secret || !registration || now - lastAttempt < 30_000) return;
  lastAttempt = now;
  const fields = new URLSearchParams({
    registration_id: registration,
    restricted_package_name: packageName,
    title,
    description: calendarWakeHint(token, now),
    payload: 'calendar-wake-v1',
    pass_through: '0',
    notify_type: '0',
    notify_id: '4106',
    time_to_live: '180000'
  });
  return fetchImpl(endpoint, {
    method: 'POST', body: fields, redirect: 'error',
    headers: { Authorization: 'key=' + secret },
    signal: AbortSignal.timeout(8000)
  }).then(async response => {
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error('Mi Push rejected calendar wake');
  }).catch(() => {
    // Delivery is ambiguous on a timeout. The saved job remains available to normal sync.
    console.warn('[phone-bridge] 小米日程唤醒发送未确认');
  });
}
