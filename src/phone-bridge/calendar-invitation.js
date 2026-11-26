import { randomUUID } from 'node:crypto';

const emailAddress = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const mailto = address => 'mailto:' + encodeURIComponent(address).replace('%40', '@');
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value < 253402300800000 && value % 1000 === 0;
const utc = value => new Date(value).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
const escapeText = value => value.replaceAll('\\', '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[;,]/g, '\\$&');

function foldLine(line) {
  let bytes = 0;
  let result = '';
  for (const character of line) {
    const length = Buffer.byteLength(character);
    if (bytes + length > 75) {
      result += '\r\n ';
      bytes = 1;
    }
    result += character;
    bytes += length;
  }
  return result;
}

export function createCalendarInvitation({ title, start, end, organizer, attendees, location = '' }, now = Date.now()) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
      typeof location !== 'string' || location.length > 300 ||
      /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(title + location) ||
      !validTime(start) || !validTime(end) || start >= end ||
      typeof organizer !== 'string' || organizer.length > 254 || !emailAddress.test(organizer) ||
      !Array.isArray(attendees) || !attendees.length || attendees.length > 20 ||
      attendees.some(address => typeof address !== 'string' || address.length > 254 || !emailAddress.test(address))) {
    return null;
  }
  const recipients = [...new Set(attendees.map(address => address.toLowerCase()))];
  const uid = randomUUID() + '@qq-agent';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QQ Agent//Calendar Invitation//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', 'UID:' + uid, 'SEQUENCE:0', 'DTSTAMP:' + utc(now),
    'DTSTART:' + utc(start), 'DTEND:' + utc(end), 'ORGANIZER:' + mailto(organizer),
    ...recipients.map(address => 'ATTENDEE;RSVP=TRUE:' + mailto(address)),
    'SUMMARY:' + escapeText(title.trim())
  ];
  if (location.trim()) lines.push('LOCATION:' + escapeText(location.trim()));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { uid, content: lines.map(foldLine).join('\r\n') + '\r\n' };
}
