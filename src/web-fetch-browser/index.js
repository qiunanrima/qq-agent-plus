import { setTimeout as delay } from 'node:timers/promises';
import { safeFetchRequest } from '../llm/safe-fetch.js';
import { withObscura } from './obscura.js';

const DOCUMENT_LIMIT = 512 * 1024;
const TEXT_LIMIT = 20_000;
const STATIC_LIMIT = 50_000;
const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i;

export async function renderObscuraDocument(url, { binary, signal }) {
  return withObscura(binary, signal, async (send) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    const navigation = await send('Page.navigate', { url, waitUntil: 'load' }, sessionId);
    if (navigation.errorText) throw new Error('Obscura 导航失败');
    await delay(1_000, undefined, { signal });
    const result = await send('Runtime.evaluate', {
      expression: [
        '(() => { const main = document.querySelector(\'main, article, [role="main"]\');',
        'return (main?.innerText?.trim() || document.body?.innerText?.trim() || "").slice(0, ',
        TEXT_LIMIT + 1, '); })()'
      ].join(''),
      returnByValue: true
    }, sessionId);
    signal.throwIfAborted();
    return typeof result.result?.value === 'string' ? result.result.value : '';
  });
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
  if (document.statusCode !== 200 || !HTML_TYPE.test(document.contentType)) return fallback;

  // Obscura serves a fresh context with its native public-network SSRF rules.
  // Let the browser preserve the page origin and enforce its normal CORS policy.
  const combined = AbortSignal.any([signal, renderSignal, AbortSignal.timeout(15_000)]);
  try {
    const text = await renderObscuraDocument(document.url, { binary, signal: combined });
    if (text) return { ...fallback, body: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT, rendered: true };
  } catch {
    signal.throwIfAborted();
  }
  return fallback;
}
