import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-links-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } = await import('../src/core/config.js');
const { cacheImageLinks, imageLinkCandidates, imageLinkTextFromSegments, readCachedImageLink } = await import('../src/onebot/image-links.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6aUAAAAASUVORK5CYII=', 'base64');
const origin = 'http://203.0.113.90';

test('批量识图兼容 messageIds，去重并保持消息与会话边界', async t => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  stubImages(t, () => ({}));
  const lookups = [];
  const ctx = { chatKey: 'private:1', stickers: { find: async () => null },
    store: { recent: () => [], findByMid: (chatKey, mid) => {
      lookups.push([chatKey, String(mid)]);
      return String(mid) === '999' ? null : { mid, text: '', media: [{ kind: 'image', url: `${origin}/batch-${mid}` }] };
    } } };
  const tool = buildToolDefs().find(tool => tool.name === 'get_message_images');
  const result = await tool.execute(ctx, { messageIds: [1073581636, 1078451414, '1073581636'] });
  assert.equal(result.isError, false);
  assert.equal(result.content.filter(part => part.type === 'image_url').length, 2);
  assert.deepEqual(lookups, [['private:1', '1073581636'], ['private:1', '1078451414']]);
  lookups.length = 0;
  const mixed = await tool.execute(ctx, { messageIds: ['1073581636', '999'] });
  assert.equal(mixed.isError, true);
  assert.equal(mixed.content.filter(part => part.type === 'image_url').length, 1);
  assert.match(JSON.stringify(mixed.content), /找不到消息 999/);
  lookups.length = 0;
  for (const ids of [[], ['1', '2', '3', '4', '5'], ['1', 'wrong'], [1.5], [null]]) {
    assert.equal((await tool.execute(ctx, { messageIds: ids })).isError, true);
  }
  assert.deepEqual(lookups, []);
  await tool.execute(ctx, { messageId: '999', messageIds: ['1073581636'] });
  assert.deepEqual(lookups, [['private:1', '999']]);
});

function stubImages(t, respond) {
  const original = http.request;
  const calls = [];
  http.request = (options, callback) => {
    if (options.hostname !== '203.0.113.90') return original(options, callback);
    calls.push(options.path);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = respond(options.path);
      const res = Readable.from([Buffer.from(response.body ?? png)]);
      res.statusCode = response.status ?? 200;
      res.headers = { 'content-type': response.type ?? 'image/png', ...(response.headers || {}) };
      callback(res);
    });
    req.destroy = () => {};
    return req;
  };
  t.after(() => { http.request = original; });
  return calls;
}

test('提取裸链接与 Markdown 链接，保留查询参数，去重并限制数量', () => {
  const sample = 'https://qqbot.ugcimg.cn/102076836/5173c477eab05a8fa0c6684cae7f34cd20742b23/7bc3dc415152673f921adc463dcc7963';
  assert.deepEqual(imageLinkCandidates(`[图片](${sample})，再看 ${sample}`), [sample]);
  assert.deepEqual(imageLinkCandidates(`${origin}/a?token=1&size=2。 ${origin}/image_(1)`), [`${origin}/a?token=1&size=2`, `${origin}/image_(1)`]);
  assert.equal(imageLinkCandidates(Array.from({ length: 8 }, (_, i) => `${origin}/${i}`).join(' ')).length, 4);
  assert.deepEqual(imageLinkCandidates('file:///a.png http://user:password@example.com/a.png'), []);
});

test('从 JSON 对象/字符串和 XML 卡片提取真实链接，不依赖展示摘要或图片扩展名', () => {
  const url = 'https://qqbot.ugcimg.cn/102076836/2bbcb45c/opaque?token=1&size=2';
  const card = { app: 'com.tencent.structmsg', meta: { news: { preview: `${origin}/cover.png`, title: '一张图', jumpUrl: url } } };
  for (const data of [card, JSON.stringify(card)]) {
    assert.deepEqual(imageLinkCandidates(imageLinkTextFromSegments([{ type: 'json', data: { data } }])), [url]);
  }
  const xml = `<msg url="${url.replace('&', '&amp;')}"><item><picture cover="${origin}/cover.png" /></item></msg>`;
  assert.deepEqual(imageLinkCandidates(imageLinkTextFromSegments([{ type: 'xml', data: { data: xml } }])), [url]);
  assert.deepEqual(imageLinkCandidates(imageLinkTextFromSegments([{ type: 'reply', data: { text: `${origin}/quoted` } }])), []);
  assert.deepEqual(imageLinkCandidates(imageLinkTextFromSegments(null, `[卡片 ${url}]`)), [url]);
});

test('模型指引把链接图片与卡片直链交给现有识图工具', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.vision = true;
  setRuntimeConfig(cfg);
  assert.match(buildToolDefs().find((tool) => tool.name === 'get_message_images').description, /不要求原消息必须有 image 段/);
  assert.match(buildSystemPrompt(), /卡片不等于网页/);
});

test('修复前的卡片存档可由取图工具补识别、缓存并返回视觉输入', async (t) => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const calls = stubImages(t, () => ({}));
  for (const refreshed of [true, false]) {
    const url = `${origin}/legacy-card-${refreshed}`;
    let appended;
    const result = await buildToolDefs().find((tool) => tool.name === 'get_message_images').execute({
      chatKey: 'group:1',
      store: {
        findByMid: () => ({ mid: '77', text: `[卡片 ${url}]`, media: [] }),
        updateByMid: (chatKey, mid, patch) => { appended = patch.appendMedia; }
      },
      onebot: { getMsg: async () => {
        if (!refreshed) throw new Error('source expired');
        return { message: [{ type: 'json', data: { data: JSON.stringify({ meta: { news: { url } } }) } }] };
      } },
      stickers: { find: async () => null }
    }, { messageId: '77' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content.some((part) => part.type === 'image_url'));
    assert.equal(appended[0].url, url);
    assert.ok(await readCachedImageLink(appended[0].cacheKey));
  }
  assert.equal(calls.length, 2);
});

test('无扩展名的真实图片缓存后进入普通识图工具，源失效也不重下载', async (t) => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const calls = stubImages(t, () => ({}));
  const url = `${origin}/opaque-image?signature=123`;
  const media = await cacheImageLinks(`看一下 [这个](${url})`);
  assert.equal(media.length, 1);
  assert.equal(media[0].url, url);
  assert.equal(media[0].kind, 'image');
  assert.deepEqual((await readCachedImageLink(media[0].cacheKey)).buffer, png);
  assert.equal((await cacheImageLinks(url))[0].cacheKey, media[0].cacheKey);
  assert.equal(calls.length, 1, '重复链接复用磁盘缓存');

  const entry = { mid: '123', text: url, media };
  const result = await buildToolDefs().find((tool) => tool.name === 'get_message_images').execute({
    chatKey: 'group:1', store: { findByMid: () => entry },
    onebot: { getMsg: async () => { throw new Error('source expired'); } },
    stickers: { find: async () => null }
  }, { messageId: '123' });
  assert.equal(result.isError, undefined);
  assert.ok(result.content.some((part) => part.type === 'image_url' && part.image_url.url === `data:image/png;base64,${png.toString('base64')}`));
  assert.equal(calls.length, 1, '识图读取缓存，不请求原链接');
});

test('原生图片刷新不会丢掉同条消息中的链接图片', async (t) => {
  const calls = stubImages(t, () => ({}));
  const media = await cacheImageLinks(`${origin}/mixed`);
  const native = `base64://${png.toString('base64')}`;
  const result = await buildToolDefs().find((tool) => tool.name === 'get_message_images').execute({
    chatKey: 'group:1', store: { findByMid: () => ({ mid: '5', media }) },
    onebot: { getMsg: async () => ({ message: [{ type: 'image', data: { url: native } }] }) },
    stickers: { find: async () => null }
  }, { messageId: '5' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.filter((part) => part.type === 'image_url').length, 2);
  assert.equal(calls.length, 1);
});

test('HTML 和伪造图片 MIME 不入缓存；octet-stream 按图片魔数识别', async (t) => {
  stubImages(t, (pathname) => pathname === '/html'
    ? { type: 'text/html', body: '<html>page</html>' }
    : pathname === '/fake.png' ? { type: 'image/png', body: '<html>fake</html>' }
      : { type: 'application/octet-stream', body: png });
  assert.deepEqual(await cacheImageLinks(`${origin}/html ${origin}/fake.png`), []);
  assert.equal((await cacheImageLinks(`${origin}/octet`)).length, 1);
});

test('自动探测拒绝内网及内网重定向，已有媒体和已取消请求不下载', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.security.allowPrivateImageHosts = true;
  setRuntimeConfig(cfg);
  const calls = stubImages(t, () => ({ status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  assert.deepEqual(await cacheImageLinks('http://127.0.0.1/private'), []);
  assert.equal(calls.length, 0, '自动探测不继承手动图片的内网例外');
  assert.deepEqual(await cacheImageLinks(`${origin}/redirect`), []);
  assert.equal(calls.length, 1);
  assert.deepEqual(await cacheImageLinks(`${origin}/existing`, { media: [{ url: `${origin}/existing` }] }), []);
  assert.deepEqual(await cacheImageLinks(`${origin}/cancel`, { signal: AbortSignal.abort() }), []);
  assert.equal(calls.length, 1);
  assert.equal(await readCachedImageLink('../outside'), null);
});

test('过期缓存不再使用，并在下一次写入时清理；损坏缓存重新下载', async (t) => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const calls = stubImages(t, () => ({}));
  const [old] = await cacheImageLinks(`${origin}/old`);
  const file = path.join(dir, 'cache', 'image-links', `${old.cacheKey}.img`);
  const past = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(file, past, past);
  assert.equal(await readCachedImageLink(old.cacheKey), null);
  const [current] = await cacheImageLinks(`${origin}/new`);
  assert.equal(fs.existsSync(file), false);
  const currentFile = path.join(dir, 'cache', 'image-links', `${current.cacheKey}.img`);
  fs.writeFileSync(currentFile, '<html>corrupt</html>');
  assert.equal(await readCachedImageLink(current.cacheKey), null);
  assert.equal((await cacheImageLinks(`${origin}/new`)).length, 1);
  assert.equal(calls.length, 3);
});

test('消息接入将文本图片链接入库并标注；图片关闭或黑名单时不探测', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: 22591, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.allow = { groups: ['1'], private: [] };
  cfg.onebot = { ...cfg.onebot, wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' };
  cfg.api = { ...cfg.api, baseUrl: '', apiKey: '', model: '', priceRemoteUrl: 'none' };
  cfg.store.blacklistKeywords = ['广告'];
  cfg.sticker.autoCollect = false;
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(() => app.stop());
  await app.start();
  const calls = stubImages(t, () => ({}));
  const event = (mid, text) => ({
    post_type: 'message', message_type: 'group', group_id: 1, user_id: 42, message_id: mid,
    sender: { user_id: 42, nickname: '甲' }, message: [{ type: 'text', data: { text } }]
  });
  async function wait(mid) {
    for (let i = 0; i < 100; i++) {
      const stored = app.store.findByMid('group:1', mid);
      if (stored) return stored;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('消息未入库');
  }
  app.onebot.onEvent(event(501, `${origin}/ingest`));
  const stored = await wait(501);
  assert.match(stored.text, /链接图片/);
  assert.equal(stored.media.length, 1);
  assert.ok(await readCachedImageLink(stored.media[0].cacheKey));
  assert.equal(calls.length, 1);
  updateConfig({ messageTypes: { ...cfg.messageTypes, images: false } });
  app.onebot.onEvent(event(502, `${origin}/disabled`));
  assert.deepEqual((await wait(502)).media, []);
  updateConfig({ messageTypes: cfg.messageTypes });
  app.onebot.onEvent(event(503, `广告 ${origin}/blocked`));
  app.onebot.onEvent(event(504, '普通消息'));
  await wait(504);
  assert.equal(app.store.findByMid('group:1', 503), null);
  assert.equal(calls.length, 1);
  // 用户报告的形态：没有 text/image 段，只有卡片段中的无后缀图床链接。
  for (const [mid, type] of [[505, 'json'], [506, 'xml']]) {
    const url = `${origin}/opaque-card-${type}`;
    const message = event(mid, '');
    message.message = [{ type, data: { data: type === 'json'
      ? JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { url } } })
      : `<msg url="${url}" />` } }];
    app.onebot.onEvent(message);
    const card = await wait(mid);
    assert.match(card.text, /卡片/);
    assert.match(card.text, /链接图片/);
    assert.equal(card.media[0].url, url);
    assert.ok(await readCachedImageLink(card.media[0].cacheKey));
  }
  assert.equal(calls.length, 3);
});
