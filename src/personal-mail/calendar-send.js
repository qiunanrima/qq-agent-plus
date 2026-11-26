import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCalendarInvitation } from '../phone-bridge/calendar-invitation.js';

export async function sendGmailCalendarInvitation(event, { dataDir, accessToken, fetchImpl = fetch, signal } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f]/.test(accessToken)) {
    return { status: 'not_authorized' };
  }
  const invitation = createCalendarInvitation(event);
  if (!invitation || event.start <= Date.now()) return { status: 'invalid_invitation' };
  if (!dataDir) return { status: 'state_unavailable' };

  const subject = [];
  let segment = '';
  for (const char of event.title.trim().replace(/\s+/gu, ' ')) {
    if (Buffer.byteLength(segment + char) > 42) {
      subject.push(segment);
      segment = '';
    }
    segment += char;
  }
  if (segment) subject.push(segment);
  const recipients = [...new Set(event.attendees.map(address => address.toLowerCase()))];
  const calendar = Buffer.from(invitation.content).toString('base64').match(/.{1,76}/g).join('\r\n');
  const internetMessageId = '<' + invitation.uid + '.invalid>';
  const message = [
    'From: ' + event.organizer,
    'To: ' + recipients.join(',\r\n '),
    'Subject: ' + subject.map(word => '=?UTF-8?B?' + Buffer.from(word).toString('base64') + '?=').join('\r\n '),
    'Message-ID: ' + internetMessageId,
    'MIME-Version: 1.0',
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
    'Content-Transfer-Encoding: base64',
    '', calendar, ''
  ].join('\r\n');
  const key = createHash('sha256').update(JSON.stringify([
    event.organizer.toLowerCase(), recipients.slice().sort(), event.title.trim(), event.start, event.end
  ])).digest('hex');
  const directory = join(dataDir, 'calendar-invitations');
  const file = join(directory, key + '.json');
  const uncertain = { status: 'unknown', uid: invitation.uid, internetMessageId };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(uncertain), { flag: 'wx', mode: 0o600, flush: true });
  } catch (error) {
    if (error.code !== 'EEXIST') return { status: 'state_unavailable' };
    try {
      const previous = JSON.parse(readFileSync(file, 'utf8'));
      return { ...previous, alreadyAttempted: true };
    } catch {
      return { status: 'unknown', alreadyAttempted: true };
    }
  }

  const timeout = AbortSignal.timeout(15000);
  try {
    const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') })
    });
    if ([400, 401, 403].includes(response.status)) {
      unlinkSync(file);
      return { status: response.status === 400 ? 'rejected' : 'not_authorized' };
    }
    if (response.ok) {
      const { id } = await response.json();
      if (typeof id === 'string' && id) {
        const sent = { status: 'sent', messageId: id, uid: invitation.uid, internetMessageId };
        writeFileSync(file + '.tmp', JSON.stringify(sent), { mode: 0o600, flush: true });
        renameSync(file + '.tmp', file);
        return sent;
      }
    }
  } catch {
    // The request may have reached Gmail even when no response arrived.
  }
  return uncertain;
}
