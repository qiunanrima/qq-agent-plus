import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendGmailCalendarInvitation } from '../src/personal-mail/calendar-send.js';

const start = Math.ceil(Date.now() / 1000) * 1000 + 86400000;
const event = { title: '报价会\r\nBcc: ignored', start, end: start + 3600000,
  organizer: 'owner@example.com', attendees: ['user@example.com'] };

test('Gmail receives a single encoded scheduling message and returns its receipt', async t => {
  const dataDir = temporaryState(t);
  let messageHeader;
  const result = await sendGmailCalendarInvitation(event, { dataDir, accessToken: 'test-token', fetchImpl: async (url, request) => {
    assert.match(url, /\/messages\/send$/);
    assert.equal(request.method, 'POST');
    const raw = Buffer.from(JSON.parse(request.body).raw, 'base64url').toString();
    assert.match(raw, /Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
    assert.doesNotMatch(raw, /^Bcc:/m);
    messageHeader = /^Message-ID: (.+)$/m.exec(raw)?.[1];
    const calendar = Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString();
    assert.match(calendar, /METHOD:REQUEST/);
    assert.match(calendar, /ATTENDEE;RSVP=TRUE:mailto:user@example.com/);
    return Response.json({ id: 'receipt42' });
  } });
  assert.equal(result.status, 'sent');
  assert.equal(result.messageId, 'receipt42');
  assert.equal(result.internetMessageId, messageHeader);
  assert.match(messageHeader, /^<[a-f0-9-]+@qq-agent\.invalid>$/);
});

test('Gmail send transport does not retry an unknown result', async t => {
  const dataDir = temporaryState(t);
  let attempts = 0;
  const result = await sendGmailCalendarInvitation(event, { dataDir, accessToken: 'test-token', fetchImpl: async () => {
    attempts += 1;
    throw new Error('connection closed');
  } });
  assert.equal(attempts, 1);
  assert.equal(result.status, 'unknown');
  assert.ok(result.internetMessageId);
  const repeated = await sendGmailCalendarInvitation(event, { dataDir, accessToken: 'test-token', fetchImpl: async () => {
    assert.fail('Must not send again');
  } });
  assert.deepEqual(repeated, { ...result, alreadyAttempted: true });
});

function temporaryState(t) {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-send-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
