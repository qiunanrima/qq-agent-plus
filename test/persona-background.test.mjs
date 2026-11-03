import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PersonaBackground, backgroundRoleKey, backgroundSections, BACKGROUND_MAX_BYTES } from '../src/persona-background/index.js';
import { registerPersonaBackgroundRoutes } from '../src/persona-background/routes.js';

const persona = { templateId: 'test-role', botName: '测试角色', roleText: '角色卡正文' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-background-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PersonaBackground({ dataDir: dir });
  const save = (text, role = persona) => store.save(role, { ...store.read(role), content: text });
  return { dir, store, save };
}

test('未导入无目录、工具或提示；按角色绑定，相同角色跨会话共用', (t) => {
  const { dir, store, save } = fixture(t);
  assert.equal(store.prompt(persona), '');
  assert.deepEqual(store.toolDefs(persona), []);
  assert.deepEqual(fs.readdirSync(dir), []);
  save('# 往事\n我曾在白玉楼等过春天。');
  assert.equal(store.read({ ...persona, botName: '改名', roleText: '更新后的内置正文' }).sections.length, 1);
  assert.equal(store.read({ ...persona, templateId: 'other' }).content, '');
  assert.notEqual(backgroundRoleKey({ roleText: '甲' }), backgroundRoleKey({ roleText: '乙' }));
});

test('Markdown按层级分段，代码块假标题不拆，长段与无标题文档可读', () => {
  const rows = backgroundSections('序言\n\n# 角色\n## 朋友\n朋友正文\n```md\n# 代码标题\n```\n\n往事\n----\n旧事');
  assert.deepEqual(rows.map((s) => s.title), ['背景正文', '角色 / 朋友', '角色 / 往事']);
  assert.match(rows[1].content, /# 代码标题/);
  assert.equal(backgroundSections('a'.repeat(9001)).length, 4);
  assert.equal(backgroundSections('无标题的中文设定')[0].content, '无标题的中文设定');
});

test('首段默认常驻，其他段仅索引，工具中文检索/按id取正文/分页', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 地点\n白玉楼位于冥界，这是正文隐藏标识。\n# 关系\n妖梦负责庭院。');
  const prompt = store.prompt(persona);
  assert.match(prompt, /主动用 persona_background_lookup/);
  assert.match(prompt, /正文隐藏标识/);
  assert.doesNotMatch(prompt, /妖梦负责庭院/);
  const tool = store.toolDefs(persona)[0];
  const lookup = async (args) => JSON.parse((await tool.execute({}, args)).content);
  assert.match((await lookup({ query: '冥界' })).entries[0].content, /正文隐藏标识/);
  assert.equal((await lookup({ sectionId: doc.sections[1].id })).entries[0].title, '关系');
  assert.equal((await lookup({})).indexes.length, 2);
  assert.equal((await lookup({ query: '不存在的背景资料' })).entries.length, 0);
  save('# 关系\n更新内容');
  assert.equal((await lookup({ sectionId: doc.sections[1].id })).entries.length, 0);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await tool.execute({ signal: aborted.signal }, {})).isError, true);
});

test('显式核心常驻，记忆模型提取话题后直接注入正文，失败回退关键词', async (t) => {
  const { store, save } = fixture(t);
  save('# 往事\n未提及的遥远故事。\n# 核心设定\n我是白玉楼的主人。\n# 庭师\n<!-- keywords: 妖梦, 半灵 -->\n魂魄妖梦照料庭院。\n# 地点\n冥界有白玉楼。');
  const system = store.prompt(persona);
  assert.match(system, /我是白玉楼的主人/);
  assert.doesNotMatch(system, /未提及的遥远故事|魂魄妖梦照料庭院/);
  let calls = 0;
  const recalled = await store.recall(persona, { text: '那个照顾院子的姑娘是谁？', complete: async (messages) => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.match(input.chat, /院子/);
    assert.match(input.catalog, /庭师/);
    return { topics: ['妖梦'] };
  } });
  assert.equal(calls, 1);
  assert.match(recalled, /魂魄妖梦照料庭院/);
  assert.doesNotMatch(recalled, /我是白玉楼的主人|未提及的遥远故事|keywords/);
  let failure;
  assert.match(await store.recall(persona, { text: '说说半灵', complete: async () => { throw new Error('离线'); },
    onError: (e) => { failure = e; } }), /魂魄妖梦/);
  assert.equal(failure.message, '离线');
  assert.equal(await store.recall(persona, { text: '吃饭了吗', complete: async () => ({ topics: [] }) }), '');
  assert.equal(await store.recall(persona, { text: '吃饭了吗', complete: async () => ({ topics: [null, {}, 'a'] }) }), '');
  const controller = new AbortController();
  await assert.rejects(store.recall(persona, { text: '妖梦', signal: controller.signal, complete: async () => {
    controller.abort(new Error('cancel')); throw controller.signal.reason;
  } }), /cancel/);
});

test('常驻和自动正文有独立预算，不越角色，无内容不调用总结模型', async (t) => {
  const { store, save } = fixture(t);
  save('# 核心设定\n' + '核心。'.repeat(3000) + '\n# 白玉楼\n' + '庭院。'.repeat(3000));
  const prompt = store.prompt(persona);
  assert.ok(prompt.length < 8500);
  const text = await store.recall(persona, { text: '白玉楼', complete: async () => ({ topics: ['白玉楼'] }) });
  assert.ok(text.length < 3900);
  assert.match(text, /节选/);
  assert.equal(await store.recall({ ...persona, templateId: 'other' }, { text: '白玉楼', complete: () => {
    assert.fail('空背景不应调用模型');
  } }), '');
});

test('模型可按语义直接选章节，不要求话题词字面命中，伪造和跨角色id被忽略', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 核心身份\n角色概览。\n# 档案乙\n从前与银杏老人一同守候落星。\n# 档案丙\n无关的旧资料。');
  const recalled = await store.recall(persona, { text: '陪在你身边的长辈是谁？', complete: async (messages) => {
    const input = JSON.parse(messages[1].content);
    assert.match(input.catalog, /银杏老人/);
    assert.match(input.catalog, new RegExp(doc.sections[1].id));
    return { sectionIds: ['forged-other-role-id', doc.sections[1].id, doc.sections[1].id], topics: [] };
  } });
  assert.match(recalled, /银杏老人/);
  assert.doesNotMatch(recalled, /无关的旧资料|forged-other-role-id/);
});

test('长标题和多别名目录公平分配扫描预算，尾部语义候选不会被开头章节挤掉', async (t) => {
  const { store, save } = fixture(t);
  const aliases = Array.from({ length: 8 }, (_, i) => `${i}${'别名'.repeat(18)}`).join(',');
  const doc = save('# 核心身份\n概述。\n' + Array.from({ length: 80 }, (_, i) =>
    `# 资料${i}${'长标题'.repeat(25)}\n<!-- keywords: ${aliases} -->\n${i === 79 ? '远方长者照料过这个角色。' : '一份无关的资料。'}`).join('\n'));
  await store.recall(persona, { text: '谈谈你的恩人', complete: async (messages) => {
    const catalog = JSON.parse(messages[1].content).catalog;
    assert.ok(catalog.length <= 12000);
    assert.ok(catalog.split('\n').some((line) => JSON.parse(line).id === doc.sections.at(-1).id));
    return { sectionIds: [doc.sections.at(-1).id], topics: [] };
  }, onError: (error) => { throw error; } });
});

test('模型离线仍可按正文检索目录后部，并围绕命中位置节选，避免相关事实被长段头部挤掉', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 核心设定\n角色概览。\n' + Array.from({ length: 100 }, (_, i) =>
    `# 文档${i}\n${i === 99 ? '旧日。'.repeat(900) + '青岚秘境位于海边，这是命中处的具体事实。' : i === 0 ? '青岚秘境还有另一份记录。' : '一份无关资料。'}`).join('\n'));
  const recalled = await store.recall(persona, { text: '青岚秘境在哪里？', complete: async (messages) => {
    assert.match(JSON.parse(messages[1].content).catalog, new RegExp(doc.sections.at(-1).id));
    assert.match(JSON.parse(messages[1].content).catalog, /青岚秘境/);
    throw new Error('offline');
  } });
  assert.match(recalled, /青岚秘境位于海边/);
  assert.match(recalled, /节选/);
});

test('多章节平均分配自动预算，核心中未常驻的后半部也可按问题补入', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 核心设定\n' + '概述。'.repeat(850) + '月影能力可以让时间暂停。\n# 甲篇\n甲篇的重要事实。' + '旧事。'.repeat(650)
    + '\n# 乙篇\n乙篇的重要事实。' + '往事。'.repeat(650));
  const core = await store.recall(persona, { text: '月影能力是什么？', complete: async () => ({ topics: ['月影能力'] }) });
  assert.match(core, /月影能力可以让时间暂停/);
  const recalled = await store.recall(persona, { text: '两段旧资料', complete: async () => ({ sectionIds: doc.sections.slice(1).map((s) => s.id) }) });
  assert.match(recalled, /甲篇的重要事实/);
  assert.match(recalled, /乙篇的重要事实/);
  const rows = recalled.split('\n').filter((line) => line.startsWith('{'));
  assert.equal(rows.length, 2);
  assert.ok(rows.join('').length <= 3600);
});

test('主动查询支持关键词别名和批量id，批量范围仍只限当前角色', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 核心设定\n角色概览。\n# 庭师\n<!-- keywords: 半灵 -->\n庭师负责照料花园。\n# 月夜\n一起赏过庭院的月亮。');
  const tool = store.toolDefs(persona)[0];
  const alias = JSON.parse(tool.execute({}, { query: '半灵' }).content);
  assert.match(alias.entries[0].content, /照料花园/);
  assert.doesNotMatch(alias.entries[0].content, /keywords/);
  const batch = JSON.parse(tool.execute({}, { sectionIds: [doc.sections[2].id, 'forged', doc.sections[1].id, doc.sections[1].id] }).content);
  assert.deepEqual(batch.entries.map((s) => s.id), [doc.sections[2].id, doc.sections[1].id]);
});

test('限制大小与分段数；并发修订冲突不覆盖，清除显式确认且自动备份', (t) => {
  const { store, dir, save } = fixture(t);
  const old = store.read(persona);
  save('# 背景\n原始内容');
  assert.throws(() => store.save(persona, { ...old, content: '丢失的写入' }), /已变化/);
  assert.throws(() => save('x'.repeat(BACKGROUND_MAX_BYTES + 1)), /512/);
  assert.throws(() => save(Array.from({ length: 513 }, (_, i) => `# ${i}\n正文`).join('\n')), /512段/);
  assert.throws(() => store.save(persona, store.read(persona), true), /确认/);
  save('# 背景\n新内容');
  store.save(persona, { ...store.read(persona), confirm: true }, true);
  assert.equal(store.read(persona).content, '');
  assert.equal(fs.readdirSync(path.join(dir, 'persona-background', 'backups')).length, 2);
  assert.deepEqual(store.toolDefs(persona), []);
});

test('大目录和长正文的分页有前进且响应有界', async (t) => {
  const { store, save } = fixture(t);
  save(Array.from({ length: 45 }, (_, i) => `# 往事${i}\n${'过去的记忆。'.repeat(500)}`).join('\n'));
  assert.match(store.prompt(persona), /分页/);
  const tool = store.toolDefs(persona)[0];
  const first = JSON.parse(tool.execute({}, {}).content);
  assert.equal(first.indexes.length, 40);
  assert.equal(first.nextOffset, 40);
  const result = JSON.parse(tool.execute({}, { query: '往事', limit: 5 }).content);
  assert.ok(result.entries.reduce((n, s) => n + s.content.length, 0) <= 6000);
  assert.ok(result.nextOffset > 0);
});

test('路由在读取body后解析角色，旧角色页面保存冲突，错误不泄露路径', async (t) => {
  const { store } = fixture(t);
  const routes = new Map();
  let cfg = { persona }, body;
  registerPersonaBackgroundRoutes({ router: { add: (method, route, fn) => routes.set(method, fn) },
    background: store, getConfig: () => cfg,
    readBody: async () => body, json: (_res, status, value) => ({ status, value }) });
  const url = new URL('http://localhost/api/persona-background');
  const call = (method) => routes.get(method)({}, {}, {}, url);
  const initial = await call('GET');
  body = { ...initial.value, content: '# 设定\n角色往事' };
  assert.equal((await call('POST')).status, 200);
  cfg = { persona: { ...persona, templateId: 'new-role' } };
  assert.equal((await call('POST')).status, 409);
  assert.equal((await call('GET')).value.content, '');
});

test('生命周期背景扫描一分钟内复用，但会话和文档修订隔离', async (t) => {
  const { store, save } = fixture(t);
  save('# 往事\n我曾住在庭院。\n# 爱好\n喜欢甜点。');
  let calls = 0;
  const complete = async () => { calls++; return { topics: ['庭院'], sectionIds: [] }; };
  await store.recall(persona, { text: '你以前住哪里', complete, scanCacheKey: 'group:1' });
  await store.recall(persona, { text: '接着说说', complete, scanCacheKey: 'group:1' });
  assert.equal(calls, 1);
  await store.recall(persona, { text: '你住哪里', complete, scanCacheKey: 'group:2' });
  assert.equal(calls, 2);
  save('# 往事\n我曾住在新庭院。\n# 爱好\n喜欢红豆。');
  await store.recall(persona, { text: '新庭院', complete, scanCacheKey: 'group:1' });
  assert.equal(calls, 3);
});

test('生命周期提词失败时短期退避，仍按当前关键词读取背景', async (t) => {
  const { store, save } = fixture(t);
  save('# 核心\n庭院主人。\n# 爱好\n喜欢红豆甜点。');
  let calls = 0;
  const complete = async () => { calls++; throw new Error('模型返回坏格式'); };
  await store.recall(persona, { text: '甜点', complete, scanCacheKey: 'group:1' });
  const content = await store.recall(persona, { text: '红豆甜点', complete, scanCacheKey: 'group:1' });
  assert.equal(calls, 1);
  assert.match(content, /红豆/);
});
