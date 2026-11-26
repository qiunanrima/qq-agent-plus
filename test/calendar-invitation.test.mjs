import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCalendarInvitation } from '../src/phone-bridge/calendar-invitation.js';

const input = {
  title: '报价会，' + '会'.repeat(30) + ', review',
  start: Date.parse('2026-11-27T14:00:00+08:00'), end: Date.parse('2026-11-27T15:00:00+08:00'),
  organizer: 'owner@example.com', attendees: ['user@example.com', 'USER@example.com'],
  location: '会议室;A\n二层'
};

test('calendar invitation preserves UTC time, deduplicates recipients and folds UTF-8 lines', () => {
  const { content, uid } = createCalendarInvitation(input, Date.parse('2026-11-26T00:00:00Z'));
  assert.ok(content.includes('METHOD:REQUEST\r\n'));
  assert.ok(content.includes('UID:' + uid + '\r\n'));
  assert.ok(content.includes('DTSTART:20261127T060000Z\r\nDTEND:20261127T070000Z\r\n'));
  assert.ok(content.includes('LOCATION:会议室\\;A\\n二层\r\n'));
  assert.equal(content.match(/ATTENDEE;/g).length, 1);
  assert.ok(content.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.match(content.replaceAll('\r\n ', ''), /SUMMARY:报价会，.*\\, review/);
});

test('calendar invitation rejects multiline email fields and invalid times', () => {
  assert.equal(createCalendarInvitation({ ...input, organizer: 'owner@example.com\nX:1' }), null);
  assert.equal(createCalendarInvitation({ ...input, end: input.start }), null);
});
