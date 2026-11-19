/* global document */
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { validateFetchUrl } from '../llm/safe-fetch.js';
import { openChromiumProxy } from './chromium-proxy.js';

const DOCUMENT_LIMIT = 20_001;

async function render(url, signal) {
  const { url: target } = await validateFetchUrl(url, { allowFakeIpDns: false });
  signal.throwIfAborted();
  const proxy = await openChromiumProxy(signal);
  let browser;
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
        '--host-resolver-rules=MAP * ~NOTFOUND'
      ],
      timeout: 5_000
    });
    signal.throwIfAborted();
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 8_000 });
    if (!response?.ok()) throw new Error('Chromium navigation failed');
    await delay(1_500, undefined, { signal });
    return await page.evaluate(limit => {
      const main = document.querySelector('main, article, [role="main"]');
      return (main?.innerText?.trim() || document.body?.innerText?.trim() || '').slice(0, limit);
    }, DOCUMENT_LIMIT);
  } finally {
    signal.removeEventListener('abort', close);
    await browser?.close().catch(() => {});
    await proxy.close();
  }
}

let busy = false;
let idle;
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/render') {
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
    const text = await render(url, signal);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
  } catch (error) {
    console.warn('Chromium request failed', error.name, String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[url]'));
    response.writeHead(502).end();
  } finally {
    busy = false;
    waitForIdle();
  }
});

function waitForIdle() {
  idle = setTimeout(() => server.close(), 5_000);
}

if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1') {
  throw new Error('Chromium worker requires its systemd socket');
}
server.listen({ fd: 3 }, waitForIdle);
