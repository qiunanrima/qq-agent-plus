import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qqa-life-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { updateConfig } = await import('../src/core/config.js');
const { buildUserPrompt } = await import('../src/llm/prompt.js');
const { openDatabase } = await import('../src/core/sqlite.js');
const { formatQuoteRef } = await import('../src/core/util.js');
const { interactionAdjustments, interactionKind } = await import('../src/character-life/emotion.js');
const { lifeStatus, observeLife, linkedMemories, claimInitiative, analyzeLife, lifeWillingness, reviewGraphAliases, reflectLife, backupLife, clearLife } = await import('../src/character-life/index.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('启停、去重、会话隔离、动机完成和可视化数据', async () => {
  const now=Date.now();
  const input={persona:{botName:'茉雪儿'},chatKey:'group:42',now,recalled:[{id:'memory-a'},{id:'memory-b'}],triggerEntries:[{id:1,senderId:'10',text:'下次一起玩',ts:now}]};
  assert.equal(observeLife(input),'');
  assert.equal(lifeStatus().profiles.length,0);
  assert.equal(fs.existsSync(path.join(dir,'character-life.sqlite')),false);
  updateConfig({characterLife:{enabled:true}});
  assert.doesNotMatch(observeLife(input),/相关的历史约定/);
  observeLife(input);
  assert.deepEqual(linkedMemories(input.persona,input.chatKey,['memory-a']),['memory-b']);
  assert.deepEqual(linkedMemories(input.persona,'private:42',['memory-a']),[]);
  assert.equal(lifeStatus().profiles[0].events.length,1);
  assert.equal(lifeStatus().profiles[0].goals.length,1);
  assert.equal(Object.keys(lifeStatus().profiles[0].dimensions).length,6);
  assert.doesNotMatch(observeLife({...input,chatKey:'group:99',triggerEntries:[{id:2,ts:now,text:'你好',senderId:'10'}]}),/邀约/);
  const done = { id:3,ts:now+5,text:'游戏已经打完了',senderId:'10' };
  observeLife({ ...input, now:now+5, triggerEntries:[done] });
  await analyzeLife({ persona:input.persona, chat:input.chatKey, messages:[done], now:now+5, allowed:() => true,
    complete:async () => ({ events:[{index:0,quote:done.text,completes:0}] }) });
  assert.equal(lifeStatus(now+5).profiles[0].goals.length,0);
  reflectLife(now+86400000);
  assert.ok(lifeStatus(now+86400000).profiles[0].reflections.length);
  updateConfig({characterLife:{enabled:false}});
  assert.equal(observeLife(input),'');
  assert.equal(lifeStatus().profiles[0].events.length,3);
  const backups=path.join(dir,'backup');
  fs.mkdirSync(backups);
  backupLife(backups,dir);
  clearLife(dir);
  assert.ok(fs.statSync(path.join(backups,'character-life.sqlite')).size);
  assert.deepEqual(lifeStatus().profiles,[]);
});

const persona = { botName: '测试角色' };
const now = Date.parse('2026-11-19T12:00:00+08:00');
const day = 86400000;
function observe(chatKey, triggerEntries, at = now) {
  return observeLife({ persona, chatKey, now: at, triggerEntries });
}

test.beforeEach(() => {
  clearLife(dir);
});

test('其他群超过 512 条新事件后，仍只提示同群符合线索的有效邀约', async () => {
  updateConfig({ characterLife: { enabled: true } });
  observe('group:1', [
    { id: 1, senderId: '10', text: '明天一起追番', ts: now - day },
    { id: 2, senderId: '11', text: '明天一起听歌', ts: now - day }
  ]);
  const done = { id:3,senderId:'11',text:'那首歌已经听完了',ts:now-day+1 };
  observe('group:1', [done]);
  await analyzeLife({ persona, chat:'group:1', messages:[done], now, allowed:() => true,
    complete:async () => ({ events:[{index:0,quote:done.text,completes:0}] }) });
  observe('group:2', Array.from({ length: 512 }, (_, i) => ({ id: i + 1, senderId: '20', text: '你好', ts: now })));
  assert.deepEqual(lifeStatus(now).profiles[0].goals.map(goal => goal.actor), ['10']);
  assert.match(observe('group:1', [{ id: 4, senderId: '10', text: '上次说的那部番', ts: now }]), /约好的剧集/);
});

test('同群不同参与者的邀约可依次领取且各只领取一次', () => {
  updateConfig({ characterLife: { enabled: true } });
  observe('group:1', [
    { id: 1, senderId: '10', text: '明天一起追番', ts: now - day },
    { id: 2, senderId: '11', text: '明天一起听歌', ts: now - day + 1 }
  ]);
  assert.match(claimInitiative(persona, 'group:1', now), /一起听歌/);
  assert.match(claimInitiative(persona, 'group:1', now), /约好的剧集/);
  assert.equal(claimInitiative(persona, 'group:1', now), '');
});

test('上海自然日的最早重算日期不会被半天计数覆盖', () => {
  updateConfig({ characterLife: { enabled: true } });
  const morning = Date.parse('2026-11-13T08:00:00+08:00');
  const afternoon = Date.parse('2026-11-13T16:00:00+08:00');
  observe('group:1', [
    { id: 1, senderId: '10', text: '你好', ts: morning },
    { id: 2, senderId: '10', text: '你好', ts: afternoon }
  ]);
  reflectLife(now - day);
  const count = () => lifeStatus(now).profiles[0].reflections.find(row => row.date === '2026-11-13')?.count;
  assert.equal(count(), 2);
  reflectLife(now);
  assert.equal(count(), 2);
});

test('语境分析保留原话门槛，动机只由对应参与者的具体进展完成', async () => {
  updateConfig({ characterLife: { enabled: true } });
  const chat = 'group:1';
  const promise = { id: 11, senderId: '10', text: '答应我等流星雨结束后一起挑胶片', ts: now };
  const wrongPerson = { id: 12, senderId: '20', text: '胶片已经挑完了', ts: now + 1000 };
  const completion = { id: 13, senderId: '10', text: '我们已经挑完流星雨胶片', ts: now + 2000 };
  const input = { persona, chat, allowed: () => true };
  observe(chat, [promise]);
  const before = lifeWillingness(persona, now);
  const create = async () => ({ events: [{ index: 0, quote: promise.text, delta: [15,0,0,0,7,-8],
    motive: { title: '一起挑流星雨胶片', reason: '对方主动约好挑胶片', condition: '双方确认胶片已经选完', topic: '胶片', hours: 36, cooldownHours: 6 } }] });
  assert.equal(await analyzeLife({ ...input, messages: [promise], now, complete: create }), 1);
  assert.ok(lifeWillingness(persona, now) > before);
  assert.equal(lifeStatus(now).profiles[0].goals[0].condition, '双方确认胶片已经选完');
  assert.equal(lifeStatus(now).willingness.length, 24);
  assert.doesNotMatch(observe(chat, [wrongPerson], now + 1000), /虚拟日常|历史约定/);
  await analyzeLife({ ...input, messages: [wrongPerson], now: now + 1000, complete: async () =>
    ({ events: [{ index: 0, quote: wrongPerson.text, completes: 0 }] }) });
  assert.equal(lifeStatus(now + 1000).profiles[0].goals.length, 1);
  observe(chat, [completion], now + 2000);
  await analyzeLife({ ...input, messages: [completion], now: now + 2000, complete: async () =>
    ({ events: [{ index: 0, quote: completion.text, completes: 0 }, { index: 1, quote: '杜撰的证据' }] }) });
  assert.deepEqual(lifeStatus(now + 2000).profiles[0].goals, []);
  assert.equal(await analyzeLife({ ...input, messages: [completion], now: now + 2000,
    complete: () => assert.fail('已分析的事件无需再次调用模型') }), 0);
});

test('没有互动也提供六维基线，晚间的多日互动可推迟节律且可以关掉微调', () => {
  updateConfig({ characterLife: { enabled: true, sleepStart: '00:00', sleepEnd: '07:00', adaptive: true } });
  assert.equal(Object.keys(lifeStatus(now, persona).profiles[0].dimensions).length, 6);
  const at = Date.parse('2026-11-19T23:10:00+08:00');
  for (let date = 18; date <= 19; date++) {
    observe('group:1', [21,22,23].map(hour => ({ id: date * 100 + hour, senderId:'10', text:'你好',
      ts: Date.parse(`2026-11-${date}T${hour}:00:00+08:00`) })), at);
  }
  const adaptive = lifeStatus(at).profiles[0];
  assert.ok(adaptive.rhythmShift > 0);
  updateConfig({ characterLife: { adaptive: false } });
  const fixed = lifeStatus(at).profiles[0];
  assert.equal(fixed.rhythmShift, 0);
  assert.notDeepEqual(adaptive.rhythm, fixed.rhythm);
});

test('图谱语义别名独立按会话储存，阻止合并不同账号且图谱未变时不重复审核', async () => {
  updateConfig({ characterLife: { enabled: true } });
  observe('group:1', [{ id: 1, senderId:'10', text:'你好', ts:now }]);
  const nodes = ['该角色','茉雪儿','QQ:10','QQ:20'].map((label,i) => ({ id:String(i), type:'entity', label }));
  const input = { chat:'group:1', graph:{ nodes, edges:[] }, now, allowed:() => true };
  assert.equal(await reviewGraphAliases({ ...input, complete:async () => ({ aliases:[{from:0,to:1},{from:2,to:3}] }) }), 1);
  assert.deepEqual(lifeStatus(now).learnedAliases, {'group:1':[['该角色','茉雪儿']]});
  assert.equal(await reviewGraphAliases({ ...input, complete:() => assert.fail('相同图谱无需重新审核') }), 0);
  clearLife(dir);
  assert.deepEqual(lifeStatus(now).learnedAliases, {});
});

test('离线复现反馈、转聊额度、存歌的约定及次日追问', async () => {
  updateConfig({ characterLife: { enabled:true, sleepStart:'00:00', sleepEnd:'07:00', adaptive:false } });
  const chat = 'private:10';
  const entry = (id, text, ts) => ({ id, text, ts, senderId:'10' });
  const feedback = entry(1, '你变了', now);
  function context(message) {
    const hint = observe(chat, [message], message.ts);
    const snapshotParts = hint ? [hint] : [];
    const prompt = buildUserPrompt({ chatKey:chat, chatId:'10', kind:'private', triggerEntries:[message],
      store:{ recent:() => [] }, memory:{ formatForPrompt:() => '' }, snapshotParts, contextLimit:0 });
    return [prompt, ...snapshotParts].join('\n');
  }
  context(feedback);
  // The stored shape from a previous version lacked a verified evidence row.
  const db = openDatabase(path.join(dir, 'character-life.sqlite'));
  try {
    db.prepare(`INSERT INTO motives(event,title,reason,condition,expires,cooldown)
      SELECT id,?,?,?,?,? FROM events WHERE chat=?`)
      .run('讨论生命系统带来的变化', '反馈', '继续聊天', now + day, 3600000, chat);
  } finally { db.close(); }
  await analyzeLife({ persona, chat, messages:[feedback], now, allowed:() => true, complete:async () => ({
    events:[{ index:0,quote:'你变了',motive:{ title:'讨论生命系统带来的变化',reason:'反馈',condition:'聊过',topic:'生命系统' } }]
  }) });
  assert.equal(lifeStatus(now).profiles[0].goals.length,0);
  for (const i of [2,3,4]) {
    const prompt = context(entry(i, '额度没了', now+i*1000));
    assert.doesNotMatch(prompt, /讨论生命系统带来的变化|相关的历史约定|做自己的事|虚拟日常/);
  }

  const song = '明天把那首歌发我';
  assert.doesNotMatch(context(entry(5,song,now+5000)), /相关的历史约定/);
  assert.equal(lifeStatus(now+5000).profiles[0].goals[0].reason,song);
  assert.doesNotMatch(context(entry(55,song,now+5500)), /相关的历史约定/);
  assert.doesNotMatch(context(entry(6,'我去上课啦',now+6000)), /相关的历史约定/);
  assert.doesNotMatch(context(entry(7,'[图片]',now+7000)), /相关的历史约定/);
  assert.equal(lifeStatus(now+7000).profiles[0].goals.length,1);
  const question = entry(8,'昨天那首呢？',now+day);
  assert.match(context(question), /相关的历史约定.*明天把那首歌发我/);
  assert.doesNotMatch(context(question), /相关的历史约定/);
  assert.doesNotMatch(context(entry(9,'额度还是没了',now+day+1000)), /相关的历史约定/);
});

test('到约定时间最多提醒一次，不因后续无关消息重复注入', () => {
  updateConfig({ characterLife:{ enabled:true } });
  const start = Date.parse('2026-11-19T13:55:00+08:00');
  const chat = 'private:10';
  observe(chat,[{id:1,senderId:'10',ts:start,text:'你下午2点把那首歌发我'}],start);
  assert.doesNotMatch(observe(chat,[{id:2,senderId:'10',ts:start+60000,text:'我在喝水'}],start+60000),/历史约定/);
  const due = start + 5*60000;
  assert.match(observe(chat,[{id:3,senderId:'10',ts:due,text:'我回来了'}],due),/历史约定/);
  assert.doesNotMatch(observe(chat,[{id:4,senderId:'10',ts:due+1000,text:'下面聊上课'}],due+1000),/历史约定/);
});

test('明确反馈即时改变情绪，普通文字互动只小幅影响孤独感', () => {
  updateConfig({ characterLife: { enabled: true, adaptive: false }, humanize: { enabled: false } });
  const at = seconds => now + seconds * 1000;
  const mood = seconds => lifeStatus(at(seconds), persona).profiles[0].dimensions;
  const send = (id, text) => observe('private:10', [{ id, senderId: '10', text, ts: at(id) }], at(id));
  const baseline = mood(0);
  send(1, '[图片]');
  assert.deepEqual(mood(1), baseline);
  send(2, '额度没了');
  assert.equal(mood(2).愉悦, baseline.愉悦);
  assert.equal(mood(2).愤怒, baseline.愤怒);
  assert.ok(mood(2).孤独感 < baseline.孤独感);
  send(3, '谢谢');
  const thanked = mood(3);
  assert.ok(thanked.愉悦 > baseline.愉悦);
  assert.ok(thanked.安全感 > baseline.安全感);
  send(3, '谢谢');
  assert.deepEqual(mood(3), thanked);
  send(4, '你说话太冲');
  assert.ok(mood(4).愤怒 > thanked.愤怒);
  send(5, '对不起');
  assert.ok(mood(5).愤怒 < mood(4).愤怒);
  assert.ok(mood(12 * 3600).愤怒 < mood(4).愤怒);
});

test('后台补正旧事件，可用完整短句作证，拒绝从长句截取短词作证', async () => {
  updateConfig({ characterLife: { enabled: true, adaptive: false } });
  const chat = 'private:10';
  const messages = [
    { id: 1, senderId: '10', text: '谢谢', ts: now },
    { id: 2, senderId: '10', text: '暖气坏了，我得联系物业', ts: now + 10 },
    { id: 3, senderId: '10', text: '好暖', ts: now + 20 }
  ];
  observe(chat, messages, now + 20);
  const db = openDatabase(path.join(dir, 'character-life.sqlite'));
  try { db.prepare("UPDATE events SET kind='互动' WHERE kind='称赞'").run(); }
  finally { db.close(); }
  assert.equal(await analyzeLife({
    persona, chat, messages, now: now + 20, allowed: () => true,
    complete: async () => ({ events: [
      { index: 1, quote: '暖气', delta: [-15, 15, 15, 0, 0, 0] },
      { index: 2, quote: '好暖', delta: { 愉悦: 6, 悲伤: 0, 愤怒: 0, 精力: 0, 安全感: 5, 孤独感: 0 } }
    ] })
  }), 3);
  const profile = lifeStatus(now + 20).profiles[0];
  assert.ok(profile.events.some(event => event.kind === '称赞'));
  assert.ok(profile.dimensions.愉悦 >= 60);
  assert.equal(profile.dimensions.愤怒, 5);
});

test('已验证的全零情绪覆盖关键词，缺失分析仍使用关键词', () => {
  const conflict = { kind: '冲突', chat: 'group:1', actor: '10', at: now };
  const baseline = interactionAdjustments([{ ...conflict, kind: '文字互动' }], now);
  assert.deepEqual(interactionAdjustments([{ ...conflict, delta: '[0,0,0,0,0,0]' }], now), baseline);
  assert.equal(interactionAdjustments([{ ...conflict, delta: '[]' }], now)[2], 9);
});

test('QQ 引用和系统表情不会作为发言者的正文进入情绪分析', async () => {
  updateConfig({ characterLife: { enabled: true, adaptive: false }, humanize: { enabled: false } });
  assert.equal(interactionKind('[引用#123·甲：滚开]好'), '文字互动');
  assert.equal(interactionKind('[引用#-123·甲：滚开[图片]]谢谢'), '称赞');
  assert.equal(interactionKind('[QQ表情14 微笑]'), '互动');
  assert.equal(interactionKind('[QQ表情14微笑]'), '互动');
  assert.equal(interactionKind('[QQ表情14]谢谢'), '称赞');
  const chat = 'group:1';
  const face = { id: 1, senderId: '10', text: '[QQ表情14 微笑]', ts: now };
  const reply = { id: 2, senderId: '10', text: '[引用#123·甲：滚开]好', ts: now + 1 };
  const baseline = lifeStatus(now, persona).profiles[0].dimensions;
  observe(chat, [face]);
  assert.deepEqual(lifeStatus(now).profiles[0].dimensions, baseline);
  observe(chat, [reply], now + 1);
  const db = openDatabase(path.join(dir, 'character-life.sqlite'));
  try {
    db.prepare('UPDATE events SET kind=? WHERE at=?').run('冲突', reply.ts);
    db.prepare('UPDATE events SET kind=? WHERE at=?').run('文字互动', face.ts);
  } finally { db.close(); }
  const analyzed = await analyzeLife({ persona, chat, messages: [face, reply], now: now + 1, allowed: () => true,
    complete: async messages => {
      assert.deepEqual(JSON.parse(messages[1].content).messages.map(row => row.text), ['好']);
      return { events: [] };
    } });
  assert.equal(analyzed, 1);
  const profile = lifeStatus(now + 1).profiles[0];
  assert.deepEqual(profile.events.map(event => event.kind), ['文字互动', '互动']);
  assert.equal(profile.dimensions.愤怒, baseline.愤怒);
});

test('未转义的历史引用边界有歧义时不归因，结构化正文仍可识别', () => {
  for (const text of ['看这里[滚开', '看这里]滚开']) {
    const reply = { messageId: '123', sender: '甲', text };
    const rendered = formatQuoteRef(reply) + '谢谢';
    assert.equal(interactionKind(rendered), '互动');
    assert.equal(interactionKind(rendered, reply), '称赞');
    assert.equal(interactionKind('谢谢' + formatQuoteRef(reply), { ...reply, bodyText: '谢谢' }), '称赞');
  }
});

test('回看旧消息后停用引用误建的待办，保留真实待办及历史证据', async () => {
  const chat = 'private:12';
  const role = { botName: '引用归因回归' };
  updateConfig({ characterLife: { enabled: true } });
  const promise = '我明天发歌给你';
  const quoted = '[引用#123·甲：' + promise + ']';
  const mistaken = { id: 121, senderId: '12', ts: now, text: quoted + '好' };
  const real = { id: 122, senderId: '12', ts: now + 1, text: quoted + promise };
  observeLife({ persona: role, chatKey: chat, triggerEntries: [mistaken, real], now: now + 1 });
  const db = openDatabase(path.join(dir, 'character-life.sqlite'));
  try {
    const { id } = db.prepare('SELECT id FROM events WHERE chat=? AND at=?').get(chat, now);
    db.prepare('INSERT INTO motives(event,title,reason,condition,expires,cooldown) VALUES(?,?,?,?,?,?)')
      .run(id, '错误的约定', mistaken.text, '确认发歌', now + 3600000, 0);
    db.prepare('INSERT INTO motive_evidence VALUES(?,?,?)').run(id, '歌曲', null);
    await analyzeLife({ persona: role, chat, messages: [mistaken, real], now: now + 2,
      allowed: () => true, complete: async () => ({ events: [] }) });
    const profile = lifeStatus(now + 2).profiles.find(profile => profile.events.some(event => event.chat === chat));
    assert.ok(profile);
    assert.deepEqual(profile.goals.map(goal => goal.title), ['把约好的歌发给对方']);
    assert.match(observeLife({ persona: role, chatKey: chat, now: now + 3, triggerEntries: [
      { id: 123, senderId: '12', ts: now + 3, text: '歌单呢' }
    ] }), /把约好的歌发给对方/);
    assert.equal(db.prepare('SELECT reason FROM motives WHERE event=?').get(id).reason, mistaken.text);
    assert.ok(db.prepare('SELECT 1 FROM motive_evidence WHERE event=?').get(id));
  } finally { db.close(); }
});
