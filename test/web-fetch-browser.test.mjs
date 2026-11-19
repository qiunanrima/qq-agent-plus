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
test('Obscura reads dynamically inserted text and only forwards allowed same-origin GETs', {
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
  const origin = 'https://qqa-render-fixture.invalid';
  const requested = [];
  const rendered = await renderObscuraDocument({
    url: origin + '/index', statusCode: 200, contentType: 'text/html',
    body: `<!doctype html><main>加载中</main><script src="/app.js"></script>`
  }, {
    binary, signal: AbortSignal.timeout(8_000),
    async fetchResource(url, options) {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.allowFakeIpDns, false);
      requested.push(url);
      if (url === origin + '/app.js') return {
        statusCode: 200, contentType: 'text/javascript',
        body: `const show = text => { document.querySelector('main').textContent = text; };
          Promise.allSettled([
            fetch('/api').then(response => response.text()).then(show),
            fetch('/save', { method: 'POST', body: 'fixture' }),
            fetch('https://other-fixture.invalid/api'),
            fetch(${JSON.stringify(localUrl)})
          ]);`
      };
      if (url === origin + '/api') return {
        statusCode: 200, contentType: 'text/plain', body: 'Obscura 动态正文'
      };
      throw new Error('unexpected fixture request');
    }
  });
  assert.deepEqual(requested, [origin + '/app.js', origin + '/api']);
  assert.equal(rendered, 'Obscura 动态正文');
  assert.equal(loopbackRequests, 0);
});

test('cancelling Obscura stops an in-flight same-origin resource', {
  skip: !binary && '需要 QQ_AGENT_OBSCURA_BIN 指向官方 Obscura 二进制'
}, async () => {
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(6_000)]);
  const reason = new Error('fixture cancelled');
  let resourceSignal;
  await assert.rejects(renderObscuraDocument({
    url: 'https://qqa-render-fixture.invalid/cancel', statusCode: 200, contentType: 'text/html',
    body: '<!doctype html><script src="/waiting.js"></script>'
  }, {
    binary, signal,
    fetchResource(_url, options) {
      resourceSignal = options.signal;
      cancel.abort(reason);
      options.signal.throwIfAborted();
    }
  }));
  assert.equal(signal.reason, reason);
  assert.equal(resourceSignal?.aborted, true);
});
