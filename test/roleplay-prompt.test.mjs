import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-roleplay-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');
const { resolvePersona } = await import('../src/personas.js');

test('三档与私聊/群聊均支持剧情，同时保留真实工具与身份边界', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  for (const behaviorProfile of ['legacy', 'grounded', 'card']) {
    for (const chatKey of ['private:12345', 'group:67890']) {
      const persona = { ...DEFAULT_CONFIG.persona, templateId: '', behaviorProfile, roleText: '你是守塔人，谨慎寡言。场景：暴雨中的灯塔。' };
      const prompt = buildSystemPrompt({ persona, chatKey });
      assert.ok(prompt.includes(persona.roleText));
      assert.match(prompt, /【角色演绎与场景连续性】/);
      assert.match(prompt, /后续已发生的变化继续有效/);
      assert.match(prompt, /不读他人内心/);
      assert.match(prompt, /不替用户答应、移动、心动/);
      assert.match(prompt, /示例里的用户不是眼前用户/);
      assert.match(prompt, /不能把剧情说成现实履历|不把剧情说成现实履历/);
      assert.match(prompt, /不谎称真人/);
      assert.match(prompt, /必须调用 send_message/);
    }
  }
});

test('按群换卡只使用生效角色；无角色时不鼓励自行建立剧情', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.roleText = '全局守塔人';
  cfg.personaPerChat = { 'group:67890': { roleText: '本群邮差', templateId: '' } };
  setRuntimeConfig(cfg);
  const prompt = buildSystemPrompt({ persona: resolvePersona(cfg, 'group:67890'), chatKey: 'group:67890' });
  assert.ok(prompt.includes('本群邮差'));
  assert.ok(!prompt.includes('全局守塔人'));
  for (const roleText of ['', '   ']) {
    assert.ok(!buildSystemPrompt({ persona: { ...cfg.persona, roleText, templateId: '' } }).includes('【角色演绎与场景连续性】'));
  }
});
