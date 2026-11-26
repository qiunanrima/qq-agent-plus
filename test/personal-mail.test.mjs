import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalMailSettings } from '../src/personal-mail/settings.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mailProviders, runPersonalMailRequest, searchPersonalMail } from '../src/personal-mail/index.js';

const env = {
  QQ_AGENT_GMAIL_CLIENT_ID: 'test-id',
  QQ_AGENT_GMAIL_CLIENT_SECRET: 'test-secret',
  QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test-refresh',
  QQ_AGENT_QQ_MAIL_USER: 'test@example.invalid',
  QQ_AGENT_QQ_MAIL_AUTH_CODE: 'test-auth-code'
};

test('mail access status and recent inbox work without a search term', async () => {
  const requested = [];
  const fetchImpl = async request => {
    const url = new URL(request);
    requested.push(url.pathname);
    if (url.pathname === '/token') return Response.json({ access_token: 'test-access' });
    if (url.pathname.endsWith('/profile')) return Response.json({});
    assert.equal(url.searchParams.get('q'), 'in:inbox newer_than:14d');
    return Response.json({});
  };
  const options = { env, fetchImpl };
  assert.deepEqual(await runPersonalMailRequest({ provider: 'gmail' }, options),
    { results: [{ provider: 'gmail', status: 'ok' }] });
  assert.deepEqual(requested, ['/token', '/gmail/v1/users/me/profile']);
  assert.deepEqual(await runPersonalMailRequest({ action: 'recent', provider: 'gmail' }, options),
    { results: [{ provider: 'gmail', status: 'ok', messages: [] }] });
});

test('Gmail follow-up reads an exact thread and distinguishes incoming replies from sent mail', async () => {
  const fetchImpl = async request => {
    const url = new URL(request);
    if (url.pathname === '/token') return Response.json({ access_token: 'test-access' });
    assert.equal(url.pathname, '/gmail/v1/users/me/threads/thread123');
    return Response.json({ messages: [
      { id: 'sent', labelIds: ['SENT'], snippet: 'Request for quote', internalDate: '1' },
      { id: 'automatic', labelIds: ['INBOX'], payload: { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] } },
      { id: 'reply', labelIds: ['INBOX'], snippet: 'Quote is ready', internalDate: '2' },
      { id: 'draft', labelIds: ['DRAFT'], snippet: 'Unsent draft', internalDate: '3' }
    ] });
  };
  const result = await runPersonalMailRequest({ action: 'thread', threadId: 'thread123' }, { env, fetchImpl });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.messages.map(({ id, direction }) => [id, direction]),
    [['sent', 'outgoing'], ['automatic', 'incoming'], ['reply', 'incoming']]);
  assert.equal(result.messages[1].automatic, true);
});

test('Gmail exact message reads bounded plain text and skips attachment content', async () => {
  const text = '报价 120 元，周五交付。' + 'x'.repeat(5000);
  const fetchImpl = async request => {
    const url = new URL(request);
    if (url.pathname === '/token') return Response.json({ access_token: 'test-access' });
    assert.equal(url.pathname, '/gmail/v1/users/me/messages/message123');
    return Response.json({ threadId: 'thread123', payload: { parts: [
      { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: 'QUJD' } },
      { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url'), size: Buffer.byteLength(text) } }
    ] } });
  };
  const result = await runPersonalMailRequest({ action: 'message', messageId: 'message123' }, { env, fetchImpl });
  assert.equal(result.contentSource, 'plain_text');
  assert.match(result.excerpt, /^报价 120 元，周五交付。/);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.excerpt) <= 4096);
  assert.match(result.source, /thread123$/);
});

test('search returns separate source references from Gmail and read-only QQ IMAP', async () => {
  assert.deepEqual(mailProviders({}), []);
  assert.deepEqual(mailProviders(env), ['gmail', 'qq']);
  const fetchImpl = async (request, options) => {
    const url = new URL(request);
    if (url.host === 'oauth2.googleapis.com') {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'test-access' });
    }
    assert.equal(url.host, 'gmail.googleapis.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('q'), '"meeting quote" newer_than:14d');
      return Response.json({ messages: [{ id: 'message123' }] });
    }
    return Response.json({ threadId: 'thread123', snippet: 'Freight is separate', internalDate: '1795596000000',
      payload: { headers: [{ name: 'Subject', value: 'Meeting with client' }], parts: [{ filename: 'quote.csv' }] } });
  };
  let closed = false;
  let released = false;
  const makeImap = (options) => {
    assert.equal(options.host, 'imap.qq.com');
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    return {
      on() {},
      async connect() {},
      async getMailboxLock(mailbox, opts) {
        assert.equal(mailbox, 'INBOX');
        assert.equal(opts.readOnly, true);
        return { release() { released = true; } };
      },
      async search(criteria, opts) {
        assert.equal(criteria.text, 'meeting quote');
        assert.equal(opts.uid, true);
        return [43];
      },
      async fetchAll() {
        return [{ uid: 43, internalDate: new Date('2026-11-25T00:00:00Z'),
          envelope: { subject: 'Meeting notes', messageId: '<meeting@example.invalid>' },
          bodyStructure: { type: 'multipart/mixed', childNodes: [
            { part: '1', type: 'text/plain' },
            { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'brief.pdf' } }
          ] } }];
      },
      async download(uid, part, opts) {
        assert.equal(uid, '43');
        assert.equal(part, '1');
        assert.equal(opts.maxBytes, 2048);
        return { content: Readable.from(['Check the estimate']) };
      },
      close() { closed = true; }
    };
  };
  const { results } = await searchPersonalMail({ query: 'meeting quote' }, { env, fetchImpl, makeImap });
  assert.equal(results[0].messages[0].source, 'https://mail.google.com/mail/u/0/#all/thread123');
  assert.deepEqual(results[0].messages[0].attachments, ['quote.csv']);
  assert.equal(results[1].messages[0].source, '<meeting@example.invalid>');
  assert.equal(results[1].messages[0].excerpt, 'Check the estimate');
  assert.deepEqual(results[1].messages[0].attachments, ['brief.pdf']);
  assert.ok(closed && released);
});

test('provider failure is isolated and never exposes account credentials', async () => {
  const fetchImpl = async () => { throw new Error('test-secret'); };
  const { results } = await searchPersonalMail({ query: '会前资料' }, {
    env, fetchImpl,
    makeImap: () => ({
      on() {}, async connect() {}, close() {},
      async getMailboxLock() { return { release() {} }; },
      async search() { return []; }
    })
  });
  assert.deepEqual(results, [
    { provider: 'gmail', status: 'unavailable', messages: [] },
    { provider: 'qq', status: 'ok', messages: [] }
  ]);
  assert.ok((await searchPersonalMail({ query: 'a\nINVALID' }, { env })).error);
});

test('panel stores encrypted credentials and keeps legacy environment configuration revocable', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qq-personal-mail-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const settings = createPersonalMailSettings({ dataDir, env: {} });
  assert.equal(settings.status().gmail.configured, false);
  const envelope = join(dataDir, 'personal-mail', 'settings.enc');
  await assert.rejects(readFile(envelope), { code: 'ENOENT' });
  assert.ok(settings.update('gmail', { enabled: true, values: { clientId: 'test-id' } }));
  assert.equal(settings.update('gmail', { enabled: true, values: {
    clientId: 'test-id', clientSecret: 'test-secret', refreshToken: 'test-refresh'
  } }), null);
  assert.match(await readFile(envelope, 'utf8'), /"tag"/);
  assert.doesNotMatch(await readFile(envelope, 'utf8'), /test-(secret|refresh)/);
  assert.equal(settings.status().gmail.enabled, true);
  assert.equal(settings.update('gmail', { enabled: false, values: { refreshToken: '' } }), null);
  assert.equal(settings.runtimeEnv().QQ_AGENT_GMAIL_REFRESH_TOKEN, undefined);
  assert.equal(settings.runtimeEnv({ includeDisabled: true }).QQ_AGENT_GMAIL_REFRESH_TOKEN, 'test-refresh');
  assert.equal(settings.status().gmail.configured, true);
  const legacy = createPersonalMailSettings({ dataDir, env });
  assert.equal(legacy.status().qq.enabled, true);
  assert.equal(legacy.update('qq', { enabled: false, values: {} }), null);
  assert.equal(legacy.runtimeEnv().QQ_AGENT_QQ_MAIL_AUTH_CODE, undefined);
});
