import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-runtime-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { webSearch, aggregateSearch } = await import('../src/llm/web-search.js');

function configure(provider, patch = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch = { ...cfg.webSearch, provider, ...patch };
  for (const name of ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso', 'doubao', 'tavily']) {
    cfg.webSearch[name] = { ...cfg.webSearch[name], apiKey: 'test-key' };
  }
  setRuntimeConfig(cfg);
}

function pending(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('所有搜索源继承本轮取消信号；预先取消时不发出网络请求', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const provider of ['bing', 'deepseek', 'zhipu', 'bocha', 'baidu', 'metaso', 'doubao', 'tavily', 'so360', 'sogou', 'bilibili', 'custom', 'custom:local']) {
    configure(provider, {
      custom: { baseUrl: 'https://custom.example/search' },
      providers: [{ id: 'local', baseUrl: 'https://custom.example/search', type: 'bing' }]
    });
    const controller = new AbortController();
    const reason = new Error(`cancel ${provider}`);
    let calls = 0;
    globalThis.fetch = async (url, { signal }) => {
      calls++;
      assert.ok(signal, provider);
      queueMicrotask(() => controller.abort(reason));
      return pending(signal);
    };
    await assert.rejects(webSearch('technical documentation', { signal: controller.signal }), (error) => error === reason, provider);
    assert.equal(calls, 1, `${provider}: cancellation must not trigger fallback requests`);
    await assert.rejects(webSearch('technical documentation', { signal: controller.signal }), (error) => error === reason);
    assert.equal(calls, 1, `${provider}: already aborted`);
  }
});

test('聚合搜索取消时终止所有并发源，不把部分结果当成功', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  configure('aggregate', { aggregate: { sources: ['tavily', 'doubao', 'bing'] } });
  const controller = new AbortController();
  const reason = new Error('run paused');
  const signals = [];
  globalThis.fetch = async (url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) return Response.json({ results: [{ title: 'partial', url: 'https://example.com/' }] });
    if (signals.length === 3) queueMicrotask(() => controller.abort(reason));
    return pending(signal);
  };
  await assert.rejects(webSearch('test', { signal: controller.signal }), (error) => error === reason);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('梗补搜被取消后不再启动 B 站、Bing 定向或 360 兜底', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  configure('bing');
  const controller = new AbortController();
  const reason = new Error('stop supplement');
  const calls = [];
  globalThis.fetch = async (url, { signal }) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response('<li class="b_algo"><h2><a href="https://example.com/">测试词</a></h2><p>测试词含义</p></li>');
    assert.match(String(url), /sogou/);
    queueMicrotask(() => controller.abort(reason));
    return pending(signal);
  };
  await assert.rejects(webSearch('测试词', { meme: true, signal: controller.signal }), (error) => error === reason);
  assert.equal(calls.length, 2);
});

test('读响应体期间取消也会终止请求', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  configure('tavily');
  const controller = new AbortController();
  const reason = new Error('stop body');
  let reading = false;
  globalThis.fetch = async (url, { signal }) => ({
    ok: true,
    json: async () => {
      reading = true;
      queueMicrotask(() => controller.abort(reason));
      return pending(signal);
    }
  });
  await assert.rejects(webSearch('test', { signal: controller.signal }), (error) => error === reason);
  assert.ok(reading);
});

test('聚合去重保留内容参数、原 URL 和源优先级；同源只请求一次', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  configure('aggregate', { aggregate: { sources: ['tavily', 'tavily', 'doubao'], count: 6 } });
  let calls = 0;
  const first = 'https://example.com/watch?v=one&lang=zh&utm_source=a#top';
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes('tavily')) return Response.json({ results: [
      { title: 'first', url: first },
      { title: 'another video', url: 'https://example.com/watch?v=two&lang=zh' },
      { title: 'article 1', url: 'https://example.com/article?id=1' },
      { title: 'unsafe', url: 'javascript:alert(1)' }
    ] });
    return Response.json({ Result: { WebResults: [
      { Title: 'duplicate', Url: 'https://example.com/watch?lang=zh&v=one&fbclid=x' },
      { Title: 'article 2', Url: 'https://example.com/article?id=2' },
      { Title: 'invalid', Url: 'not a URL' }
    ] } });
  };
  const result = await aggregateSearch('test');
  assert.equal(calls, 2);
  assert.deepEqual(result.sources, ['tavily', 'doubao']);
  assert.deepEqual(result.results.map((item) => item.title), ['first', 'another video', 'article 1', 'article 2']);
  assert.equal(result.results[0].url, first);
  assert.equal(result.results[0].source, 'tavily');
});
