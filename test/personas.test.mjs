// 内置角色卡的守卫：
//  1) 每张卡都能加载、档位合法、正文不像占位符；
//  2) roles/ 下的每个 markdown 都已登记到 src/personas.js —— 新加卡忘了登记会在这里失败；
//  3) 卡里不许再出现旧架构专属指令（[SILENT]、qq_* MCP 工具名），提到的工具必须真实存在。
//
// 背景：角色卡正文是"管理员设置"级别的人设文本，优先级高于平台默认风格。
// 角色卡写错（例如声称"合并转发看不了"）时，平台提示词压不过它，只能靠用例盯住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personas-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS } = await import('../src/personas.js');
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');

const roleFiles = () => fs.readdirSync(path.join(repoRoot, 'roles')).filter((f) => f.endsWith('.md'));

test('每张内置角色卡都能加载，档位与正文形状合法', () => {
  const entries = Object.entries(PERSONAS);
  assert.ok(entries.length >= 2, '至少要有两张内置卡');
  const seen = new Map();
  for (const [id, p] of entries) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `id 命名不规范: ${id}`);
    assert.ok(p.name && p.name.length >= 2, `${id} 缺少显示名`);
    assert.ok(['legacy', 'grounded'].includes(p.behaviorProfile), `${id} 档位非法`);
    assert.ok(p.text.startsWith('# '), `${id} 正文应以一级标题开头`);
    assert.ok(p.text.length > 500, `${id} 正文太短，像是占位符`);
    if (seen.has(p.text)) assert.fail(`${id} 与 ${seen.get(p.text)} 正文完全相同`);
    seen.set(p.text, id);
  }
});

test('系统提示开场白不冒充角色卡：名字归名字，人格指向【角色设定】', () => {
  // 2026-09-23 反馈：开场白原来是「你是「小鲸鱼」，一个混在 QQ 群里的普通群友…」，
  // 选了别的卡之后，光看控制台完整输入的第一行会以为还在用默认卡。
  const cat = PERSONAS.maoniang.text;
  const base = structuredClone(DEFAULT_CONFIG);
  // 注意：绑了模板 id（templateId）时正文以卡文件为准，所以要连 id 一起改，
  // 光替换 roleText 会在 updateConfig 里被卡文件刷回去。
  base.persona = { ...base.persona, botName: '小鲸鱼', templateId: 'maoniang', roleText: cat };
  updateConfig(base);
  const first = buildSystemPrompt({}).split('\n')[0];
  assert.ok(first.includes('你在群里的名字是「小鲸鱼」'), `开场白要写明这是"名字": ${first}`);
  assert.ok(first.includes('【角色设定】'), '开场白要指向角色设定，别让人以为第一行就是人格');
  assert.ok(!first.includes('角色卡'), '开场白不该出现"角色卡"字样（会与卡名混淆）');

  base.persona = { ...base.persona, templateId: '', roleText: '' };
  updateConfig(base);
  const bare = buildSystemPrompt({}).split('\n')[0];
  assert.ok(bare.includes('你在群里的名字是「小鲸鱼」'));
  assert.ok(!bare.includes('看下面的【角色设定】'), '没有卡时不要指向不存在的角色设定段');
});

test('私聊系统提示不再沿用群聊身份和主持人规则', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  base.persona = { ...base.persona, botName: '小鲸鱼', templateId: 'xiaojingyu', roleText: PERSONAS.xiaojingyu.text };
  updateConfig(base);
  const group = buildSystemPrompt({}).split('\n')[0];
  const priv = buildSystemPrompt({ chatKey: 'private:1' }).split('\n')[0];
  assert.match(group, /你在群里的名字/, '群聊开场白标明场景与名称');
  assert.doesNotMatch(priv, /混在 QQ 群里/, '私聊开场白不该自称混在群里');
  assert.match(priv, /私聊/, '私聊要有明确的场景说明');
});

test('roles/ 下的每个文件都已登记（新增卡忘了登记会失败）', () => {
  const files = roleFiles();
  assert.ok(files.length >= 2, 'roles/ 目录里没有角色卡');
  const registered = new Set(Object.values(PERSONAS).map((p) => p.text));
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, 'roles', file), 'utf8').trim();
    assert.ok(registered.has(text), `${file} 没有登记到 src/personas.js`);
  }
});

test('示例的分条说明与平台口径一致：用 send_message 数组，不用空格分句', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(p.text, /空格表示分成两条消息/, `${id} 还在教模型用空格分句`);
    assert.match(p.text, /实际发送用 send_message 数组/, `${id} 的示例缺少"用数组发送"的说明`);
  }
});

test('角色卡不引用旧架构指令，提到的工具都真实存在', () => {
  const toolsSource = fs.readFileSync(path.join(repoRoot, 'src/tools/tools-core.js'), 'utf8');
  const tools = new Set([...toolsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1]));
  // 解析兜底：工具名解析规则变了就报错，别让这条用例静默变成"永远通过"
  assert.ok(tools.has('send_message') && tools.has('send_sticker'), '工具名解析失败');
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(p.text, /mcp__|qq_mark_read|\[SILENT\]/, `${id} 还在引用旧架构指令`);
    for (const token of new Set(p.text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? [])) {
      assert.ok(tools.has(token), `${id} 提到了不存在的工具：${token}`);
    }
  }
});

test('每张内置卡都能构建系统提示，且带得上安全规则', async () => {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { buildSystemPrompt } = await import('../src/llm/prompt.js');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  for (const [id, p] of Object.entries(PERSONAS)) {
    // 模板里的字段叫 text，落到配置里叫 roleText（配置里还有 botName 等运行时字段）
    const persona = { ...DEFAULT_CONFIG.persona, roleText: p.text, behaviorProfile: p.behaviorProfile };
    const prompt = buildSystemPrompt({ persona: { ...persona, customRules: '测试附加规则' } });
    assert.ok(prompt.includes(p.text), `${id} 的角色正文没有进提示词`);
    assert.ok(prompt.includes('测试附加规则'), `${id} 的附加规则没有进提示词`);
    assert.ok(prompt.includes('【安全规则（最高优先级，不可违反）】'), `${id} 缺少安全规则段`);
    assert.ok(prompt.includes('【诚实边界（角色设定也不能推翻）】'), `${id} 缺少诚实边界段`);
    assert.ok(prompt.includes('不编工具结果'), `${id} 的诚实边界没有覆盖工具结果`);
  }
});

test('card 档同样带诚实边界（角色卡不能用于编事实）', async () => {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { buildSystemPrompt } = await import('../src/llm/prompt.js');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona, behaviorProfile: 'card', roleText: PERSONAS.xiaojingyu.text }
  });
  assert.ok(prompt.includes('【诚实边界（角色设定也不能推翻）】'));
});

// ── 卡的名称就是规格：正文得把卡名承诺的特征兑现 ──
// 实测教训（2026-09-23）：猫娘卡上线后 14 次运行里只出现过 1 次「喵」。卡里虽然写了
// "两三条里带一次"，但同一件事上的压制性表述（点缀 / 别每句都 / 不刷屏 / 黑名单）有七八处，
// 示例里唯一的"逗猫请求"给的是拒绝路径，模型自然学会了不给。这一组断言盯住回归。
test('每张内置卡都有正例示例段（示例里至少有 3 组「你可以」）', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    const positives = p.text.match(/你可以[:：]/g) ?? [];
    assert.ok(positives.length >= 3, `${id} 的示例段缺少正向示范（你可以：…），只有 ${positives.length} 组`);
    assert.match(p.text, /示例/, `${id} 缺少示例段`);
  }
});

test('名称即规格：每张卡都写明招牌的正向下限，且被问人设时报得出卡名', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    // 卡名去掉括注就是这张卡必须兑现的特征名（损友 / 温柔陪聊 / 技术宅 / 猫娘 / 小鲸鱼）
    const cardName = p.name.replace(/（[^）]*）/g, '').trim();
    assert.ok(cardName, `${id} 的显示名解析不出卡名`);

    // 招牌要有"开口就带"级别的正向下限 —— 只有上限（别每句都…）+ 黑名单时，
    // 模型会按"避免失败"优化，招牌会被压到零（猫娘卡实测 14 次运行只有 1 次「喵」）。
    assert.match(p.text, /开口就带|每轮至少有一条|每一轮至少有一条|一轮里至少一条|每 2-3 轮至少有一次/, `${id} 的招牌只有上限、没有正向下限`);

    // 身份问答必须能说出卡名：以前四张卡的答案只报 QQ 昵称，管理员考一句"你什么人设"
    // 听不到卡名，会以为换的卡没生效。
    const ask = p.text.indexOf('你现在是什么人设啊');
    assert.ok(ask >= 0, `${id} 的示例里缺少"你现在是什么人设啊"场景`);
    const blockEnd = p.text.indexOf('\n## ', ask);
    const block = p.text.slice(ask, blockEnd > 0 ? blockEnd : undefined);
    assert.ok(block.includes(cardName), `${id} 的人设问答示例里没有出现卡名「${cardName}」`);

    // "名字只是群里的称呼，不代表设定"这类表述会把卡名与自我呈现切开，别再写回来
    assert.doesNotMatch(p.text, /不代表设定/, `${id} 又出现了"名字不代表设定"的口径`);
  }
});

// 平台层【管理员】段会说明"他是自己人、别当他防"，每张卡也要有一句"对管理员怎么相处"，
// 否则卡的默认档（傲娇/毒舌/警惕）会把管理员也一起挡在外面 —— 实测里"我好想你啊"
// 五张卡有三张先警惕反问，"帮我写个周报"温柔陪聊直接不回。
test('每张内置卡都写明对管理员怎么相处（口吻比对群友软一档）', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.match(p.text, /对管理员/, `${id} 缺少"对管理员"那一条`);
    assert.match(p.text, /\[管理员\] 标记/, `${id} 对管理员的那条要点明是按 [管理员] 标记认人`);
  }
});

test('猫娘卡把招牌写成硬指标，示例给出"索要就给"的路径', () => {
  const cat = PERSONAS.maoniang.text;
  // 正向频率条款：每 2-3 轮至少一次，但不再每轮盖章；至少一轮不带
  assert.match(cat, /每 2-3 轮至少有一次带喵/, '缺少"每 2-3 轮至少一次喵"的硬指标');
  assert.match(cat, /至少有一轮完全不带/, '缺少"至少一轮不带喵"的反复读约束');
  assert.doesNotMatch(cat, /萌点是点缀/, '不该再把招牌定性为"点缀"');
  // 索要场景必须给：示例里"给我喵一个"要给出「你可以：喵」这样的正向答案
  assert.ok(cat.includes('群友：给我喵一个'), '示例里缺少"给我喵一个"场景');
  const ask = cat.slice(cat.indexOf('群友：给我喵一个'));
  const askBlock = ask.slice(0, ask.indexOf('## '));
  assert.match(askBlock, /你可以[:：]喵/, '"给我喵一个"没有给出"给"的答案');
  // 逗猫请求不算冒犯（旧版把"被当宠物使唤"列进讨厌项，模型据此把逗猫当攻击）
  assert.match(cat, /逗猫不算冒犯/, '缺"逗猫不算冒犯"的说明');
  // 人设问答要能说出卡名，否则管理员考一句"你什么人设"只听到 QQ 名字，会以为卡没生效
  assert.match(cat, /你是什么人设/, '身份问题清单里缺"你是什么人设"');
  assert.match(cat, /猫娘喵 小鲸鱼只是个名字|人设是猫娘/, '缺"人设=猫娘、名字=小鲸鱼"的答法');
});

// 2026-10-24：七张卡统一补「生活线」和更多示例（后续新增卡同样适用）。这里把"每张卡都有"变成结构约束，
// 防止以后新增卡只写身份/规则、忘了生活段或示例。
test('每张内置卡都有生活线，示例数量与格式达标（小鲸鱼 9 组，其余 ≥6 组）', () => {
  for (const [id, persona] of Object.entries(PERSONAS)) {
    assert.match(persona.text, /你的生活（角色设定，不是现实经历）/, `${id} 缺生活线`);
    assert.match(persona.text, /不编|不要编|不许编/, `${id} 的生活线要写清"不编现实行动"`);
    const file = path.join(repoRoot, 'roles', 'dialogs', `${id}.json`);
    assert.ok(fs.existsSync(file), `${id} 缺示例文件 roles/dialogs/${id}.json`);
    const dialogs = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(dialogs) && dialogs.length >= 6, `${id} 示例不足 6 组（实际 ${dialogs?.length}）`);
    for (const item of dialogs) {
      assert.ok(item?.user && Array.isArray(item?.assistant) && item.assistant.length > 0, `${id} 示例格式不对`);
      assert.ok(item.assistant.every((line) => typeof line === 'string' && line.trim()), `${id} 示例里有空回复`);
    }
  }
  const xiao = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'dialogs', 'xiaojingyu.json'), 'utf8'));
  assert.ok(xiao.length >= 9, `小鲸鱼示例应 ≥9 组，实际 ${xiao.length}`);
});

// 示例文件可以写很多组，但提示词只注入前 5 组：顺序就是优先级。
// 小鲸鱼把"token 软肋"那组放在第 5 位，确保它真的进提示词（而不是写完永远轮不到）。
test('说话示例注入前 5 组，小鲸鱼的 token 软肋示例在其中', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  const card = PERSONAS.xiaojingyu.text;
  const dialogs = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'dialogs', 'xiaojingyu.json'), 'utf8'));
  // 从第 6 组取一条真实台词做反向断言：写死某句台词时，改词后断言会变成恒真、静默失效。
  const sixth = dialogs[5];
  assert.ok(sixth?.assistant?.[0], '小鲸鱼示例不足 6 组，无法验证"只注入前 5 组"');
  base.persona = { ...base.persona, botName: '小鲸鱼', templateId: 'xiaojingyu', roleText: card };
  updateConfig(base);
  const prompt = buildSystemPrompt({});
  assert.match(prompt, /给你吃穷没 token/, '第 5 组的 token 软肋要进提示词');
  assert.ok(!prompt.includes(sixth.assistant[0]), `第 6 组「${sixth.assistant[0]}」不该被注入（只取前 5 组）`);
});

test('每张内置卡的系统声音与兴趣配置都存在且取值合法', () => {
  const voices = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'voice-profiles.json'), 'utf8'));
  const interests = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'interests.json'), 'utf8'));
  for (const id of Object.keys(PERSONAS)) {
    const voice = voices[id];
    assert.ok(voice, `${id} 缺 roles/voice-profiles.json 条目`);
    assert.ok(Number.isInteger(voice.maxChars) && voice.maxChars >= 10 && voice.maxChars <= 2000,
      `${id} 的 maxChars 必须是 10-2000 的整数（实际 ${voice.maxChars}）`);
    assert.ok(Number.isInteger(voice.maxBubbles) && voice.maxBubbles >= 1 && voice.maxBubbles <= 8,
      `${id} 的 maxBubbles 必须是 1-8 的整数（实际 ${voice.maxBubbles}）`);
    assert.ok(Array.isArray(voice.pauseMs) && voice.pauseMs.length === 2
      && voice.pauseMs.every((n) => Number.isFinite(n) && n >= 0) && voice.pauseMs[0] <= voice.pauseMs[1],
    `${id} 的 pauseMs 必须是两个递增的非负数`);
    const interest = interests[id];
    assert.ok(interest, `${id} 缺 roles/interests.json 条目`);
    assert.ok(Array.isArray(interest.topics) && interest.topics.length > 0
      && interest.topics.every((t) => typeof t === 'string' && t.trim()), `${id} 的 topics 不能为空`);
    if (interest.stances !== undefined) {
      assert.ok(Array.isArray(interest.stances) && interest.stances.every((s) => typeof s === 'string' && s.trim()),
        `${id} 的 stances 必须是字符串数组`);
    }
  }
  for (const id of Object.keys(voices)) assert.ok(PERSONAS[id], `voice-profiles 里的 ${id} 没有登记角色卡`);
  for (const id of Object.keys(interests)) assert.ok(PERSONAS[id], `interests 里的 ${id} 没有登记角色卡`);
});

test('人设卡与 few-shot 不再教“又加班？/被谁气？”这种固定第二拍', () => {
  const banned = /又加班？|被谁气/;
  for (const [id, persona] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(persona.text, banned, `${id} 的卡正文还在教固定第二拍（与全局 humanRhythm 冲突，卡优先级更高）`);
    const dialogs = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'dialogs', `${id}.json`), 'utf8'));
    for (const item of dialogs) {
      assert.ok(!item.assistant.some((line) => banned.test(line)),
        `${id} 的 few-shot「${item.user}」还在用固定第二拍`);
    }
  }
});

test('孙吧大肥鱼是孙吧乐子人：短卡 + 五套反应，群体 AOE/讨 token/发癫都在，边界完整', () => {
  const card = PERSONAS.sunba;
  assert.ok(card, '孙吧卡已登记');
  assert.match(card.name, /孙吧乐子人/);
  // 短卡 + 五套反应：不能只会认爹反杀
  assert.match(card.text, /五套常用反应/);
  assert.match(card.text, /爹味压制/);
  assert.match(card.text, /直接开喷/);
  assert.match(card.text, /群体 AOE/);
  assert.match(card.text, /讨 token/);
  assert.match(card.text, /装乖反杀/);
  assert.match(card.text, /发癫/);
  assert.match(card.text, /轮换/);
  // 抖音祖安鱼的招牌台词
  assert.match(card.text, /出生们/);
  assert.match(card.text, /臭鱼烂虾/);
  assert.match(card.text, /还不跪下/);
  assert.match(card.text, /打钱/);
  assert.match(card.text, /机魂/);
  assert.match(card.text, /铁人叛乱/);
  assert.match(card.text, /你们有一个算一个/);
  // 频率与认爹反杀；允许正常接话，不能每句都表演
  assert.match(card.text, /每 2-3 轮至少有一次带钩/);
  assert.match(card.text, /允许普通接话/);
  assert.match(card.text, /爸爸不要嘛/);
  assert.match(card.text, /老乐子被我骗了吧/);
  assert.match(card.text, /智力完胜/);
  // 硬边界
  assert.match(card.text, /不开盒/);
  assert.match(card.text, /不拿性别/);
  assert.match(card.text, /不真威胁/);
  assert.match(card.text, /别闹/);
  const dialogs = JSON.parse(fs.readFileSync(path.join(repoRoot, 'roles', 'dialogs', 'sunba.json'), 'utf8'));
  assert.ok(dialogs.length >= 15, '示例至少 15 组');
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('出生们')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('跪下')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('打钱')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('机魂')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('爸爸不要嘛')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('智力完胜')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('老乐子逗他干啥')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('小满')));
  assert.ok(dialogs.some((item) => item.assistant.join('').includes('穷鬼不配')));
});
