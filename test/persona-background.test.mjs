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

test('仅注入索引，工具中文检索/按id取正文/分页，编辑后立即读新版本', async (t) => {
  const { store, save } = fixture(t);
  const doc = save('# 地点\n白玉楼位于冥界，这是正文隐藏标识。\n# 关系\n妖梦负责庭院。');
  const prompt = store.prompt(persona);
  assert.match(prompt, /主动用 persona_background_lookup/);
  assert.doesNotMatch(prompt, /正文隐藏标识|妖梦负责庭院/);
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
