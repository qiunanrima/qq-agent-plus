import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skills-'));
process.env.QQ_AGENT_DATA_DIR = __dir;
process.on('exit', () => { try { fs.rmSync(__dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { SkillRegistry, resetSkillRegistryForTests, skillBlocksTool, skillGateMessage } = await import('../src/skills/registry.js');
const { buildUserPrompt } = await import('../src/llm/prompt.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools-core.js');
const { executeTool: dispatchTool } = await import('../src/tools/tools.js');

const writeSkill = (root, dir, manifest, body = '# 流程\n\n按步骤做。\n') => {
  const target = path.join(root, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'skill.json'), JSON.stringify(manifest));
  if (body !== null) fs.writeFileSync(path.join(target, 'SKILL.md'), body);
  return target;
};

test('内置技能包可加载，字段与工具白名单有效', () => {
  const registry = new SkillRegistry();
  const ids = registry.list().map((skill) => skill.id);
  assert.deepEqual(ids.sort(), ['chat-summary', 'comment-analysis', 'personal-briefing', 'video-digest']);
  assert.ok(registry.get('personal-briefing').allowedTools.includes('phone_calendar'));
  assert.equal(registry.errors.length, 0);
  const summary = registry.get('chat-summary');
  assert.equal(summary.name, '群聊总结');
  assert.ok(summary.allowedTools.includes('send_message'));
  assert.match(summary.instructions, /不要引用私聊内容/);
});

test('personal briefing reads only matching synced phone notifications in the owner chat', async t => {
  const token = process.env.QQ_AGENT_PHONE_TOKEN;
  process.env.QQ_AGENT_PHONE_TOKEN = 'a'.repeat(64);
  t.after(() => {
    if (token === undefined) delete process.env.QQ_AGENT_PHONE_TOKEN;
    else process.env.QQ_AGENT_PHONE_TOKEN = token;
  });
  const owner = '12345';
  const chatKey = 'private:' + owner;
  updateConfig({
    admin: { ownerUin: owner },
    skills: { enabled: true, enabledIds: [], perChat: { __replace__: { [chatKey]: ['personal-briefing'] } } }
  });
  for (const text of ['今天有什么需要我提前处理？', '周五还没回就帮我拟一封跟进']) {
    const prompt = buildUserPrompt({
      chatKey, chatId: owner, kind: 'private',
      store: { recent: () => [] },
      memory: { formatForPrompt: () => '' },
      triggerEntries: [{ id: 1, senderId: owner, ts: Date.now(), text }]
    });
    assert.match(prompt, /本轮用户原话匹配已启用的工作流：personal-briefing/);
  }
  const dir = path.join(__dir, 'phone-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const receivedAt = '2026-11-26T01:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify([
    { source: 'com.tencent.mm', title: '微信通知', body: '样例', receivedAt },
    { source: 'com.tencent.mobileqq', title: 'QQ 通知', body: '样例', receivedAt },
    { source: 'com.example.other', title: '其他应用', body: '样例', receivedAt }
  ]));
  fs.writeFileSync(path.join(dir, 'notification-sync.json'), JSON.stringify({ lastSyncAt: '2026-11-26T01:05:00.000Z' }));
  const defs = buildToolDefs();
  const ctx = { chatKey, session: {}, triggerEntries: [{ senderId: owner, text: '汇总手机通知，看看微信' }] };
  const active = await dispatchTool(defs, ctx, 'skill_use', '{"id":"personal-briefing"}');
  assert.equal(active.isError, undefined);
  const read = await dispatchTool(defs, ctx, 'phone_notifications', '{}');
  assert.equal(read.isError, undefined);
  const parsed = JSON.parse(read.content);
  assert.deepEqual(parsed.events.map(event => event.source), ['com.tencent.mm']);
  assert.equal(parsed.lastSyncAt, '2026-11-26T01:05:00.000Z');
  ctx.triggerEntries[0].text = '汇总微信和 QQ 通知';
  const multiple = JSON.parse((await dispatchTool(defs, ctx, 'phone_notifications', '{}')).content);
  assert.deepEqual(multiple.events.map(event => event.source).sort(), ['com.tencent.mm', 'com.tencent.mobileqq']);
  const group = await dispatchTool(defs, { ...ctx, chatKey: 'group:1' }, 'phone_notifications', '{}');
  assert.equal(group.isError, true);
  const start = Date.now() + 600000;
  const event = { eventId: '42', title: '现有会议', start, end: start + 60000, allDay: false, location: '' };
  fs.writeFileSync(path.join(dir, 'calendar.json'), JSON.stringify({
    from: start - 60000, to: start + 120000, receivedAt, events: [event]
  }));
  const editContext = { chatKey, triggerEntries: [{ senderId: owner, text: '行，就照刚才说的改' }] };
  const edit = await dispatchTool(defs, editContext, 'phone_calendar_write', JSON.stringify({
    action: 'update', eventId: event.eventId, originalStart: start, start: start + 60000
  }));
  assert.equal(edit.isError, undefined);
  const [job] = JSON.parse(fs.readFileSync(path.join(dir, 'calendar-writes.json'), 'utf8'));
  assert.equal(job.operation, 'update');
  assert.equal(job.end, start + 120000);
  assert.equal(job.expected.start, start);
  editContext.triggerEntries[0].text = '好，帮我加一下';
  const createArgs = JSON.stringify({ action: 'create', title: '新增事项', start, end: start + 60000 });
  assert.equal((await dispatchTool(defs, editContext, 'phone_calendar_write', createArgs)).isError, undefined);
  const denied = await dispatchTool(defs, { ...editContext, chatKey: 'group:1' }, 'phone_calendar_write', createArgs);
  assert.equal(denied.isError, true);
  assert.equal(denied.reportIncident, false);
});

test('技能 manifest 校验：坏 id、超长正文、缺 SKILL.md 都会被拒绝', () => {
  const userDir = fs.mkdtempSync(path.join(__dir, 'bad-skills-'));
  writeSkill(userDir, 'bad-id', { id: 'Bad ID', name: '坏 id' });
  writeSkill(userDir, 'oversize', { id: 'oversize', name: '太长' }, 'x'.repeat(65 * 1024));
  writeSkill(userDir, 'missing', { id: 'missing', name: '缺正文' }, null);
  writeSkill(userDir, 'good', {
    id: 'good', name: '好技能', description: 'ok', version: '1.0.0',
    allowedTools: ['send_message'], triggers: ['试试']
  });
  const registry = new SkillRegistry({ builtinDir: path.join(__dir, 'no-builtin'), userDir });
  const ids = registry.list().map((skill) => skill.id);
  assert.deepEqual(ids, ['good']);
  assert.equal(registry.errors.length, 3);
  assert.ok(registry.errors.some((item) => /id/.test(item.error)));
  assert.ok(registry.errors.some((item) => /64KB/.test(item.error)));
  assert.ok(registry.errors.some((item) => /SKILL\.md/.test(item.error)));
});

test('技能启用按会话隔离：全局列表 + perChat 覆盖', () => {
  updateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    skills: { enabled: true, enabledIds: ['chat-summary'], perChat: { __replace__: { 'group:2': ['video-digest'] } } }
  });
  const registry = new SkillRegistry();
  assert.deepEqual(registry.enabledForChat('group:1').map((skill) => skill.id), ['chat-summary']);
  assert.deepEqual(registry.enabledForChat('group:2').map((skill) => skill.id), ['video-digest']);
  updateConfig({ skills: { enabled: false, enabledIds: ['chat-summary'], perChat: { __replace__: {} } } });
  assert.deepEqual(registry.enabledForChat('group:1'), []);
});

test('skill_list / skill_use 只注册在开启后，并收窄工具集合', async () => {
  updateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    skills: { enabled: true, enabledIds: ['chat-summary'], perChat: { __replace__: {} } }
  });
  resetSkillRegistryForTests();
  const defs = buildToolDefs();
  assert.ok(defs.some((def) => def.name === 'skill_list'));
  assert.ok(defs.some((def) => def.name === 'skill_use'));
  const ctx = { chatKey: 'group:1', session: {} };
  const listed = await executeTool(defs, ctx, 'skill_list', '{}');
  assert.match(listed.content, /群聊总结/);
  assert.equal(ctx.pendingSkillUse, true);
  const used = await executeTool(defs, ctx, 'skill_use', JSON.stringify({ id: 'chat-summary' }));
  assert.equal(used.isError, undefined);
  assert.match(used.content, /群聊总结/);
  assert.equal(ctx.pendingSkillUse, false);
  assert.equal(ctx.activeSkill.id, 'chat-summary');
  assert.equal(skillBlocksTool(ctx.activeSkill, 'send_message'), false);
  assert.equal(skillBlocksTool(ctx.activeSkill, 'web_fetch'), true);
  assert.equal(skillBlocksTool(ctx.activeSkill, 'finish'), false);
  assert.match(skillGateMessage(null, true, 'web_fetch'), /先调用 skill_use/);
  assert.equal(skillGateMessage(null, true, 'send_message'), '');
  assert.equal(skillGateMessage(null, true, 'finish'), '');
  assert.match(skillGateMessage(ctx.activeSkill, false, 'web_fetch'), /本轮只允许/);

  const blocked = await executeTool(defs, ctx, 'skill_use', JSON.stringify({ id: 'video-digest' }));
  assert.equal(blocked.isError, true, '未启用的技能不能切换');
});

test('技能通过 plugin_call 调插件工具时按限定名校验', async () => {
  updateConfig({
    ...structuredClone(DEFAULT_CONFIG),
    skills: { enabled: true, enabledIds: ['video-digest'], perChat: { __replace__: {} } }
  });
  resetSkillRegistryForTests();
  const defs = buildToolDefs();
  const ctx = { chatKey: 'group:1', session: {} };
  assert.equal((await executeTool(defs, ctx, 'skill_use', JSON.stringify({ id: 'video-digest' }))).isError, undefined);
  const skill = ctx.activeSkill;
  // 技能只需声明 bilibili__read；plugin_call 本身不必在白名单里。
  assert.equal(skillBlocksTool(skill, 'plugin_call', { tool: 'bilibili__read', args: { url: 'BV1xx' } }), false);
  assert.equal(skillBlocksTool(skill, 'plugin_call', { tool: 'bilibili__search' }), false);
  assert.equal(skillBlocksTool(skill, 'plugin_call', { tool: 'bilibili__download' }), true);
  assert.equal(skillBlocksTool(skill, 'plugin_call', {}), true);
  assert.equal(skillBlocksTool(skill, 'plugin_call'), true);
  assert.match(skillGateMessage(skill, false, 'plugin_call', { tool: 'bilibili__download' }), /本轮只允许/);
  assert.equal(skillGateMessage(skill, false, 'plugin_call', { tool: 'bilibili__read' }), '');
  // 直接调用（非 meta 挂载）仍按名字校验，未列出的插件工具被拦。
  assert.equal(skillBlocksTool(skill, 'bilibili__read'), false);
  assert.equal(skillBlocksTool(skill, 'bilibili__download'), true);
});

test('关闭技能包时不注册 skill 工具，也不加载用户技能', () => {
  updateConfig({ ...structuredClone(DEFAULT_CONFIG), skills: { enabled: false, enabledIds: [], perChat: { __replace__: {} } } });
  resetSkillRegistryForTests();
  const defs = buildToolDefs();
  assert.equal(defs.some((def) => def.name === 'skill_list'), false);
  assert.equal(defs.some((def) => def.name === 'skill_use'), false);
});
