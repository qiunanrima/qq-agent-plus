import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { buildToolDefs } from '../src/tools/tools-core.js';
import { getConfig, setRuntimeConfig } from '../src/core/config.js';
import { webFetch } from '../src/llm/web-search.js';
import { renderObscuraDocument } from '../src/web-fetch-browser/index.js';
import { openChromiumProxy } from '../src/web-fetch-browser/chromium-proxy.js';
import {
  normalizeWebFetchBrowserConfig, syncWebFetchBrowser, tryStartWebFetchBrowser
} from '../src/web-fetch-browser/config.js';

test('browser fetch is opt-in and its slot is released separately from graduation', () => {
  assert.deepEqual(normalizeWebFetchBrowserConfig(), { enabled: false, graduated: false });
  assert.deepEqual(normalizeWebFetchBrowserConfig({ enabled: 'true', graduated: true }), {
    enabled: false, graduated: true
  });
  assert.equal(tryStartWebFetchBrowser({ webFetchBrowser: { enabled: false, graduated: true } }), null);
  const enabled = { webFetchBrowser: { enabled: true, graduated: false } };
  const active = tryStartWebFetchBrowser(enabled);
  try {
    assert.equal(tryStartWebFetchBrowser(enabled), null);
    syncWebFetchBrowser({ ...enabled, webSearch: { enabled: false } });
    assert.equal(active.signal.aborted, true);
    assert.equal(tryStartWebFetchBrowser(enabled), null);
  } finally {
    active.release();
  }
  tryStartWebFetchBrowser(enabled).release();
});

test('fetch_url advertises render only while enabled and rejects private targets', async () => {
  const original = structuredClone(getConfig());
  try {
    const tool = () => buildToolDefs().find(def => def.name === 'fetch_url');
    setRuntimeConfig({ ...structuredClone(original), webFetchBrowser: { enabled: false } });
    assert.equal(tool().parameters.properties.render, undefined);
    setRuntimeConfig({ ...structuredClone(original), webFetchBrowser: { enabled: true } });
    assert.equal(tool().parameters.properties.render.type, 'boolean');
    await assert.rejects(webFetch('http://127.0.0.1/', { render: true }), /禁止访问内网/);
  } finally {
    setRuntimeConfig(original);
  }
});

const binary = process.env.QQ_AGENT_OBSCURA_BIN;
test('Obscura renders JavaScript while the browser blocks loopback requests', {
  skip: !binary && '需要 QQ_AGENT_OBSCURA_BIN 指向官方 Obscura 二进制'
}, async (t) => {
  let loopbackRequests = 0;
  const fixture = createServer((_request, response) => {
    loopbackRequests += 1;
    response.end('local fixture');
  });
  fixture.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  await once(fixture, 'listening');

  const localUrl = 'http://127.0.0.1:' + fixture.address().port + '/fixture';
  const html = `<!doctype html><main>加载中</main><script>
    const show = text => { document.querySelector('main').textContent = text; };
    fetch(${JSON.stringify(localUrl)}).then(() => show('unexpected'), () => show('Obscura 动态正文'));
  </script>`;
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  const rendered = await renderObscuraDocument(url, { binary, signal: AbortSignal.timeout(8_000) });
  assert.equal(rendered, 'Obscura 动态正文');
  assert.equal(loopbackRequests, 0);
});

test('Obscura rejects a cancelled render', {
  skip: !binary && '需要 QQ_AGENT_OBSCURA_BIN 指向官方 Obscura 二进制'
}, async () => {
  const signal = AbortSignal.timeout(200);
  await assert.rejects(renderObscuraDocument('about:blank', { binary, signal }));
  assert.equal(signal.aborted, true);
});

test('Chromium proxy rejects both an HTTP request and a CONNECT to loopback', async (t) => {
  let requests = 0;
  const target = createServer((_request, response) => { requests += 1; response.end(); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise(resolve => target.close(resolve)));
  const proxy = await openChromiumProxy(AbortSignal.timeout(3_000));
  t.after(() => proxy.close());
  const address = '127.0.0.1:' + target.address().port;
  for (const [method, path] of [['GET', 'http://' + address + '/'], ['CONNECT', address]]) {
    const status = await new Promise((resolve, reject) => {
      const outgoing = httpRequest(proxy.url, { method, path });
      outgoing.on('response', response => { response.resume(); resolve(response.statusCode); });
      outgoing.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
      outgoing.on('error', reject);
      outgoing.end();
    });
    assert.equal(status, 403);
  }
  assert.equal(requests, 0);
});
