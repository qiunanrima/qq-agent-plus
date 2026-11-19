import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buildToolDefs } from '../src/tools/tools-core.js';
import { getConfig, setRuntimeConfig } from '../src/core/config.js';
import { webFetch } from '../src/llm/web-search.js';
import { renderObscuraDocument } from '../src/web-fetch-browser/index.js';
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
