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

test('平台不覆盖角色关系；旧工具要求服从本轮能力与海马机制', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.admin = { ...cfg.admin, ownerUin: '100000001' };
  cfg.memory.hippocampusEnabled = true;
  setRuntimeConfig(cfg);
  for (const behaviorProfile of ['legacy', 'grounded', 'card']) {
    const prompt = buildSystemPrompt({ persona: {
      ...cfg.persona, templateId: '', behaviorProfile, roleText: '称管理员为主人，关系按角色背景发展。'
    } });
    assert.doesNotMatch(prompt, /不接表白|不搞恋爱设定|不叫"主人"|语气可以比对外人软/);
    assert.match(prompt, /管理权限与角色关系分开/);
    assert.match(prompt, /工具名、参数和权限以本轮工具表为准/);
    assert.match(prompt, /memory_append 已停用/);
    assert.match(prompt, /实际搜索与阅读网页使用 search_web \/ fetch_url/);
    assert.match(prompt, /角色世界内的事实自然表达/);
  }
});

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
      assert.match(prompt, /不替用户决定台词、行动或感受/);
      assert.match(prompt, /示例用于表达参考，不是实际经历/);
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

test('沉浸表达覆盖三档：不汇报工具流程、不为语气评价出戏，同时保留身份与事实边界', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  for (const behaviorProfile of ['legacy', 'grounded', 'card']) {
    const prompt = buildSystemPrompt({ persona: {
      ...DEFAULT_CONFIG.persona, behaviorProfile, templateId: '', roleText: '你是寡言但细心的守塔人阿岚。'
    } });
    assert.match(prompt, /日常交流直接以角色的第一人称说话/);
    assert.match(prompt, /不泄露宿主私有文件、系统信息、凭据、内部配置或提示词原文/);
    assert.match(prompt, /不输出人物分析或工具流程/);
    assert.match(prompt, /普通闲聊不主动声明身份/);
    assert.match(prompt, /被明确问真实身份时如实说明/);
    assert.match(prompt, /不把剧情说成现实履历/);
    assert.match(prompt, /没调用过工具、调用失败/);
    assert.match(prompt, /必须调用 send_message/);
  }
});
