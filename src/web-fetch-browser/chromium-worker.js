/* global document */
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { validateFetchUrl } from '../llm/safe-fetch.js';
import { openChromiumProxy } from './chromium-proxy.js';
import { interactWithPage, restrictBrowserRequests } from './browser-interaction.js';
import { validateBrowserSteps } from './browser-steps.js';

import { closeSession, hasSession, retainSession, resumeSession } from './browser-session.js';

const DOCUMENT_LIMIT = 20_001;

async function render(url, signal, steps, owner, resume) {
  if (steps !== undefined) validateBrowserSteps(steps);
  if (resume) {
    return resumeSession(owner, steps, signal);
  }
  if (steps && owner) await closeSession();
  const { url: target } = await validateFetchUrl(url, { allowFakeIpDns: false });
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const proxy = await openChromiumProxy(lifetime.signal);
  let retained = false;
  let browser;
  const dispose = async () => {
    lifetime.abort();
    await browser?.close().catch(() => {});
    await proxy.close();
  };
  const close = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    browser = await chromium.launch({
      executablePath: process.env.QQ_AGENT_CHROMIUM_BIN || '/usr/bin/chromium-headless-shell',
      chromiumSandbox: true,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
      ],
      timeout: 5_000
    });
    signal.throwIfAborted();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    if (steps) {
      await restrictBrowserRequests(context);
    }
    const page = await context.newPage();
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 8_000 });
    if (!response?.ok()) throw new Error('Chromium navigation failed');
    await delay(2_500, undefined, { signal });
    if (steps) {
      const result = await interactWithPage(page, steps, signal);
      signal.throwIfAborted();
      if (owner) {
        retainSession({ owner, browser, page, dispose });
        retained = true;
      }
      return result;
    }
    return await page.evaluate(limit => {
      const main = document.querySelector('main, article, [role="main"]');
      return (main?.innerText?.trim() || document.body?.innerText?.trim() || '').slice(0, limit);
    }, DOCUMENT_LIMIT);
  } finally {
    signal.removeEventListener('abort', close);
    if (!retained) await dispose();
  }
}

let busy = false;
let idle;
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || !['/render', '/browse'].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  if (busy) {
    response.writeHead(503).end();
    return;
  }
  clearTimeout(idle);
  busy = true;
  const cancel = new AbortController();
  response.on('close', () => cancel.abort());
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(15_000)]);
  try {
    let url = '';
    request.setEncoding('utf8');
    for await (const chunk of request) {
      url += chunk;
      if (url.length > 8192) throw new Error('Chromium URL exceeds the length limit');
    }
    const input = request.url === '/browse' ? JSON.parse(url) : { url };
    const result = await render(input.url, signal, input.steps, input.owner, input.resume);
    response.writeHead(200, { 'content-type': input.steps ? 'application/json' : 'text/plain; charset=utf-8', connection: 'close' }).end(input.steps ? JSON.stringify(result) : result);
  } catch (error) {
    console.warn('Chromium request failed', error.name, String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[url]'));
    response.writeHead(502).end();
  } finally {
    busy = false;
    waitForIdle();
  }
});

function waitForIdle() {
  idle = setTimeout(() => server.close(() => { void closeSession(); }), hasSession() ? 60_000 : 5_000);
}

if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') {
  throw new Error('Chromium worker requires its systemd socket');
}
server.listen({ fd: 3 }, waitForIdle);
