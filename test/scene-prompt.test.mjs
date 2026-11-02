import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/core/config.js';
import { buildSystemPrompt } from '../src/llm/prompt.js';

function scene(cfg) {
  setRuntimeConfig(cfg);
  const text = buildSystemPrompt({ persona: { ...cfg.persona, roleText: '' }, chatKey: 'group:1' });
  return text.slice(text.indexOf('【QQ 场景规则】'), text.indexOf('【玩法与工具箱】')).trim();
}

test('默认场景规则控制在2100字符，保留搜索和图片链接关键边界', () => {
  const text = scene(structuredClone(DEFAULT_CONFIG));
  assert.ok(text.length <= 2100, `场景规则过长：${text.length}`);
  for (const value of ['search_web', 'fetch_url', 'count默认5、最多20', '只有摘要就不声称读过正文',
    'qqbot.ugcimg.cn', 'get_message_images', 'read_forward', 'meme=true', 'meme_lookup', 'meme_remember']) {
    assert.ok(text.includes(value), value);
  }
  assert.match(text, /普通词不必逢词就搜/);
  assert.match(text, /对方要求识图、读字或解释时正常描述/);
  assert.doesNotMatch(text, /禁止描述画面|单独发词本身就是该查一下|卡片消息.*占位符无法查看|2026-10-12/);
});

test('禁用搜索不残留搜索工具指引，视频声音和画面独立说明', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.webSearch.enabled = false;
  cfg.api.vision = true;
  cfg.messageTypes.videoFrames = false;
  let text = scene(cfg);
  assert.doesNotMatch(text, /search_web|fetch_url|meme=true/);
  assert.match(text, /联网不可用/);
  assert.match(text, /视频画面看不到/);
  assert.match(text, /get_message_images/);
  cfg.messageTypes.images = false;
  cfg.messageTypes.stickers = false;
  text = scene(cfg);
  assert.match(text, /get_message_images 不在工具表里/);
  assert.match(text, /get_sticker_image 不在工具表里/);
  assert.match(text, /看不到图/);
  assert.doesNotMatch(text, /可以用 get_message_images/);
});
