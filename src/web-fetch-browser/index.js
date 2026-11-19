import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { safeFetchRequest } from '../llm/safe-fetch.js';
import { withObscura } from './obscura.js';

const DOCUMENT_LIMIT = 512 * 1024;
const RESOURCE_LIMIT = 256 * 1024;
const MAX_RESOURCES = 20;
const TEXT_LIMIT = 20_000;
const STATIC_LIMIT = 50_000;
const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;
const RESOURCE_TYPE = /^(?:text\/(?!html$)[\w.+-]+|application\/(?:javascript|ecmascript|json|[\w.+-]+\+json))$/i;
const CSP = [
  "sandbox allow-scripts allow-same-origin",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

function writeResponse(response, page, isDocument = false) {
  const type = page.contentType.split(';')[0].trim();
  response.writeHead(page.statusCode, {
    'content-type': type + '; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...(isDocument ? { 'content-security-policy': CSP } : {})
  });
  response.end(page.body);
}

export async function renderObscuraDocument(document, {
  binary, signal, fetchResource = safeFetchRequest
}) {
  // A synthetic HTTP origin lets the proxy serve resources without tunnelling TLS.
  // QQA retains the real destination and makes every upstream connection itself.
  const source = new URL(document.url);
  const page = new URL('http://' + randomBytes(16).toString('hex') + '.invalid');
  page.pathname = source.pathname;
  page.search = source.search;

  const lifetime = new AbortController();
  const scoped = AbortSignal.any([signal, lifetime.signal]);
  let requests = 0;
  let mainServed = false;
  const handleRequest = async (request, response) => {
    const target = URL.parse(request.url);
    if (scoped.aborted || request.method !== 'GET' || target?.origin !== page.origin
      || target.username || target.password) {
      response.writeHead(403).end();
      return;
    }
    if (!mainServed && target.href === page.href) {
      mainServed = true;
      writeResponse(response, document, true);
      return;
    }
    if (target.href === page.href || requests >= MAX_RESOURCES) {
      response.writeHead(403).end();
      return;
    }
    requests += 1;
    const upstream = new URL(source.origin);
    upstream.pathname = target.pathname;
    upstream.search = target.search;
    const resource = await fetchResource(upstream.href, {
      signal: scoped, redirect: 'manual', decompress: true, maxBytes: RESOURCE_LIMIT, allowFakeIpDns: false
    });
    const type = resource.contentType?.split(';')[0].trim();
    if (resource.statusCode < 200 || resource.statusCode >= 300 || resource.truncated
      || !RESOURCE_TYPE.test(type || '') || Buffer.byteLength(resource.body, 'utf8') > RESOURCE_LIMIT) {
      response.writeHead(403).end();
      return;
    }
    writeResponse(response, resource);
  };

  try {
    return await withObscura(binary, scoped, handleRequest, async (send) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      const navigation = await send('Page.navigate', { url: page.href, waitUntil: 'load' }, sessionId);
      if (!mainServed || navigation.errorText) throw new Error('Obscura 导航失败');
      await delay(750, undefined, { signal: scoped });
      const result = await send('Runtime.evaluate', {
        expression: [
          '(() => { const main = document.querySelector(\'main, article, [role="main"]\');',
          'return (main?.innerText?.trim() || document.body?.innerText?.trim() || "").slice(0, ',
          TEXT_LIMIT + 1, '); })()'
        ].join(''),
        returnByValue: true
      }, sessionId);
      scoped.throwIfAborted();
      return typeof result.result?.value === 'string' ? result.result.value : '';
    });
  } finally {
    lifetime.abort();
  }
}

export async function fetchBrowserPage(url, { signal, renderSignal, binary }) {
  const document = await safeFetchRequest(url, {
    signal, maxBytes: DOCUMENT_LIMIT, decompress: true, allowFakeIpDns: false
  });
  signal.throwIfAborted();
  const fallback = {
    url: document.url,
    statusCode: document.statusCode,
    body: document.body.slice(0, STATIC_LIMIT),
    truncated: document.truncated || document.body.length > STATIC_LIMIT,
    rendered: false
  };
  const target = new URL(document.url);
  if (document.statusCode !== 200 || document.truncated || target.port
    || Buffer.byteLength(document.body, 'utf8') > DOCUMENT_LIMIT || !HTML_TYPE.test(document.contentType)) {
    return fallback;
  }
  const combined = AbortSignal.any([signal, renderSignal, AbortSignal.timeout(8_000)]);
  try {
    const text = await renderObscuraDocument(document, { binary, signal: combined });
    if (text) return { ...fallback, body: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT, rendered: true };
  } catch {
    signal.throwIfAborted();
  }
  return fallback;
}
