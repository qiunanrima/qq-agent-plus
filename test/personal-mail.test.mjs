import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mailProviders, searchPersonalMail } from '../src/personal-mail/index.js';

const env = {
  QQ_AGENT_GMAIL_CLIENT_ID: 'test-id',
  QQ_AGENT_GMAIL_CLIENT_SECRET: 'test-secret',
  QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test-refresh',
  QQ_AGENT_QQ_MAIL_USER: 'test@example.invalid',
  QQ_AGENT_QQ_MAIL_AUTH_CODE: 'test-auth-code'
};

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
