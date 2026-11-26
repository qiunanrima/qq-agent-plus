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
  assert.match(active.content, /fallbackQuery/);
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
  ctx.triggerEntries[0].text = '接下来有什么会要准备？';
  const calendar = await dispatchTool(defs, ctx, 'phone_calendar', JSON.stringify({
    from: start + 60000, to: start + 120000
  }));
  assert.equal(calendar.isError, undefined);
  const emptyCalendar = JSON.parse(calendar.content);
  assert.equal(emptyCalendar.coverage, 'full');
  assert.deepEqual(emptyCalendar.events, []);
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
  const invite = JSON.stringify({ action: 'send_calendar_invitation', attendees: ['person@example.invalid'] });
  for (const text of ['不要发送日历邀请给 person@example.invalid', '请发送日历邀请给 other@example.invalid']) {
    const result = await dispatchTool(defs, {
      chatKey, triggerEntries: [{ senderId: owner, text }]
    }, 'personal_mail_search', invite);
    assert.equal(result.isError, true);
    assert.match(result.content, /提供每位收件人的邮箱/);
  }
  const groupInvite = await dispatchTool(defs, {
    chatKey: 'group:1', triggerEntries: [{ senderId: owner, text: '发送日历邀请给 person@example.invalid' }]
  }, 'personal_mail_search', invite);
  assert.equal(groupInvite.isError, true);
  assert.match(groupInvite.content, /管理员 QQ 私聊/);
  const denied = await dispatchTool(defs, { ...editContext, chatKey: 'group:1' }, 'phone_calendar_write', createArgs);
  assert.equal(denied.isError, true);
  assert.equal(denied.reportIncident, false);
});

test('meeting preparation tools preserve matching calendar, mail and workspace evidence', async () => {
  const { selectPhoneCalendar } = await import('../src/phone-bridge/index.js');
  const { runPersonalMailRequest } = await import('../src/personal-mail/index.js');
  const { parseWorkspaceSearch, workspaceSearchCommand } = await import('../src/tools/linux-container.js');
  const start = Date.parse('2026-11-27T06:00:00Z');
  const meeting = { eventId: '42', title: 'Orchid quote review', start, end: start + 3600000 };
  const range = { from: start - 3600000, to: start + 7200000 };
  const calendar = selectPhoneCalendar({ ...range, events: [meeting] }, range, range.from);
  assert.equal(calendar.coverage, 'full');
  assert.equal(calendar.events[0].title, meeting.title);

  const env = { QQ_AGENT_GMAIL_CLIENT_ID: 'test', QQ_AGENT_GMAIL_CLIENT_SECRET: 'test', QQ_AGENT_GMAIL_REFRESH_TOKEN: 'test' };
  const fetchImpl = async request => {
    const url = new URL(request);
    if (url.pathname === '/token') return Response.json({ access_token: 'test' });
    if (url.pathname.endsWith('/messages')) {
      return Response.json({ messages: url.searchParams.get('q').startsWith('"Orchid"') ? [{ id: 'mail42' }] : [] });
    }
    return Response.json({ threadId: 'orchid42', snippet: 'New quote request', payload: {
      mimeType: 'text/plain', body: { data: Buffer.from('List freight as a separate line before the meeting.').toString('base64url') }
    } });
  };
  const options = { env, fetchImpl };
  const { results: [mail] } = await runPersonalMailRequest({
    action: 'search', provider: 'gmail', query: calendar.events[0].title, fallbackQuery: 'Orchid'
  }, options);
  const { excerpt, source } = await runPersonalMailRequest({ action: 'message', messageId: mail.messages[0].messageId }, options);
  assert.match(excerpt, /freight as a separate line/);
  assert.match(source, /orchid42$/);

  const directory = '/workspace/Orchid';
  assert.ok(workspaceSearchCommand(directory, ['quote'], '会前查 /workspace/Orchid'));
  const { files } = parseWorkspaceSearch([
    '1700000000\t120\t' + directory + '/quote-v1.csv',
    '1700000010\t182\t' + directory + '/quote-v2.csv',
    ''
  ].join('\0'));
  assert.deepEqual(files.map(file => file.path), [directory + '/quote-v2.csv', directory + '/quote-v1.csv']);
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
