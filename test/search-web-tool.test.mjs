import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-web-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const { webSearch } = await import('../src/llm/web-search.js');
const { skillBlocksTool } = await import('../src/skills/registry.js');
const { experimentalToolClass } = await import('../src/pilots/experimental-tool-scheduler.js');
const { canonicalToolName } = await import('../src/tools/names.js');

function configure(provider = 'deepseek') {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch.provider = provider;
  cfg.webSearch.deepseek = { ...cfg.webSearch.deepseek, apiKey: 'private-test-key', count: 3 };
  setRuntimeConfig(cfg);
  return cfg;
}
const results = (n) => Array.from({ length: n }, (_, i) => ({ title: `标题${i}`, url: `https://example.com/${i}`, summary: `摘要${i}` }));

test('模型只获得search_web/fetch_url，数量默认5且最多20，旧名仍可调用', async (t) => {
  configure();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const defs = buildToolDefs();
  const search = defs.find((d) => d.name === 'search_web');
  assert.ok(search);
  assert.ok(defs.find((d) => d.name === 'fetch_url'));
  assert.ok(!defs.some((d) => ['web_search', 'web_fetch'].includes(d.name)));
  assert.equal(search.parameters.properties.count.default, 5);
  assert.equal(search.parameters.properties.count.maximum, 20);
  const counts = [];
  globalThis.fetch = async (_url, opts) => {
    counts.push(JSON.parse(opts.body).count);
    return Response.json({ results: results(30) });
  };
  const first = await executeTool(defs, {}, 'search_web', JSON.stringify({ query: '天气' }));
  assert.equal(JSON.parse(first.content).results.length, 5);
  assert.doesNotMatch(first.content, /private-test-key/);
  const maximum = await executeTool(defs, {}, 'search_web', JSON.stringify({ query: '资料', count: 20 }));
  assert.equal(JSON.parse(maximum.content).results.length, 20);
  const legacy = await executeTool(defs, {}, 'web_search', JSON.stringify({ query: '旧技能', count: 2 }));
  assert.equal(JSON.parse(legacy.content).results.length, 2);
  assert.deepEqual(counts, [5, 20, 2]);
  for (const count of [0, -1, 21, 1.5, '5', true]) {
    const failed = await executeTool(defs, {}, 'search_web', JSON.stringify({ query: '不会联网', count }));
    assert.equal(failed.isError, true);
    assert.match(failed.content, /1–20/);
  }
  assert.equal(counts.length, 3, '非法数量不调用后端');
});

test('并发请求的数量不串会话，也不修改供应商全局配置', async (t) => {
  const cfg = configure();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const counts = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    counts.set(body.query, body.count);
    if (body.query === 'one') await gate;
    else release();
    return Response.json({ results: results(30) });
  };
  const [one, many] = await Promise.all([webSearch('one', { count: 1 }), webSearch('many', { count: 20 })]);
  assert.equal(one.results.length, 1);
  assert.equal(many.results.length, 20);
  assert.equal(counts.get('one'), 1);
  assert.equal(counts.get('many'), 20);
  assert.equal(cfg.webSearch.deepseek.count, 3);
});

test('旧技能白名单/只读调度识别新旧名字，兼容不放宽其他工具权限', () => {
  for (const name of ['search_web', 'web_search', 'fetch_url', 'web_fetch']) {
    assert.equal(experimentalToolClass(name), 'parallel-read');
    assert.equal(skillBlocksTool({ allowedTools: new Set(['web_search', 'web_fetch']) }, name), false);
  }
  assert.equal(skillBlocksTool({ allowedTools: new Set(['web_search']) }, 'send_message'), true);
  assert.equal(canonicalToolName('constructor'), 'constructor');
  assert.equal(canonicalToolName('__proto__'), '__proto__');
});

test('上游结果不足时不编造补足，聚合结果统一遵守本次count', async (t) => {
  const cfg = configure();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => Response.json({ results: results(2) });
  const few = await webSearch('only two', { count: 20 });
  assert.equal(few.results.length, 2);
  cfg.webSearch.provider = 'aggregate';
  cfg.webSearch.aggregate.sources = ['doubao', 'bocha'];
  cfg.webSearch.bocha.apiKey = 'test-key';
  cfg.webSearch.doubao.apiKey = 'test-key';
  globalThis.fetch = async (url) => String(url).includes('feedcoopapi')
    ? Response.json({ Result: { WebResults: results(30).map((r, i) => ({ Title: r.title, Url: `https://second.example/${i}`, Snippet: r.summary })) } })
    : Response.json({ data: { webPages: { value: results(30) } } });
  assert.equal((await webSearch('aggregate', { count: 7 })).results.length, 7);
});
