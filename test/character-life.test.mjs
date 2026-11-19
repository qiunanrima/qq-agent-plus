import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qqa-life-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { updateConfig } = await import('../src/core/config.js');
const { lifeStatus, observeLife, linkedMemories, claimInitiative, analyzeLife, lifeWillingness, reviewGraphAliases, reflectLife, backupLife, clearLife } = await import('../src/character-life/index.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('启停、去重、会话隔离、动机完成和可视化数据', () => {
  const now=Date.now();
  const input={persona:{botName:'茉雪儿'},chatKey:'group:42',now,recalled:[{id:'memory-a'},{id:'memory-b'}],triggerEntries:[{id:1,senderId:'10',text:'下次一起玩',ts:now}]};
  assert.equal(observeLife(input),'');
  assert.equal(lifeStatus().profiles.length,0);
  assert.equal(fs.existsSync(path.join(dir,'character-life.sqlite')),false);
  updateConfig({characterLife:{enabled:true}});
  assert.match(observeLife(input),/邀约/);
  observeLife(input);
  assert.deepEqual(linkedMemories(input.persona,input.chatKey,['memory-a']),['memory-b']);
  assert.deepEqual(linkedMemories(input.persona,'private:42',['memory-a']),[]);
  assert.equal(lifeStatus().profiles[0].events.length,1);
  assert.equal(lifeStatus().profiles[0].goals.length,1);
  assert.equal(Object.keys(lifeStatus().profiles[0].dimensions).length,6);
  assert.doesNotMatch(observeLife({...input,chatKey:'group:99',triggerEntries:[{id:2,ts:now,text:'你好',senderId:'10'}]}),/邀约/);
  observeLife({...input,now:now+5,triggerEntries:[{id:3,ts:now+5,text:'接着聊',senderId:'10'}]});
  assert.equal(lifeStatus().profiles[0].goals.length,0);
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

test('其他群超过 512 条新事件后，有效邀约和回应仍参与结算', () => {
  updateConfig({ characterLife: { enabled: true } });
  observe('group:1', [
    { id: 1, senderId: '10', text: '明天一起追番', ts: now - day },
    { id: 2, senderId: '11', text: '明天一起听歌', ts: now - day }
  ]);
  observe('group:1', [{ id: 3, senderId: '11', text: '接着聊', ts: now - day + 1 }]);
  observe('group:2', Array.from({ length: 512 }, (_, i) => ({ id: i + 1, senderId: '20', text: '你好', ts: now })));
  assert.deepEqual(lifeStatus(now).profiles[0].goals.map(goal => goal.actor), ['10']);
  assert.match(observe('group:1', [{ id: 4, senderId: '10', text: '你好', ts: now }]), /约好的剧集/);
});

test('同群不同参与者的邀约可依次领取且各只领取一次', () => {
  updateConfig({ characterLife: { enabled: true } });
  observe('group:1', [
    { id: 1, senderId: '10', text: '明天一起追番', ts: now - day },
    { id: 2, senderId: '11', text: '明天一起听歌', ts: now - day + 1 }
  ]);
  assert.match(claimInitiative(persona, 'group:1', now), /聊到的歌/);
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
  const promise = { id: 11, senderId: '10', text: '答应我等流星雨结束后一起挑照片', ts: now };
  const wrongPerson = { id: 12, senderId: '20', text: '照片已经挑完了', ts: now + 1000 };
  const completion = { id: 13, senderId: '10', text: '我们已经挑完流星雨照片', ts: now + 2000 };
  const input = { persona, chat, allowed: () => true };
  observe(chat, [promise]);
  const before = lifeWillingness(persona, now);
  const create = async () => ({ events: [{ index: 0, quote: promise.text, delta: [15,0,0,0,7,-8],
    motive: { title: '一起挑流星雨照片', reason: '对方主动约好挑照片', condition: '双方确认照片已经选完', hours: 36, cooldownHours: 6 } }] });
  assert.equal(await analyzeLife({ ...input, messages: [promise], now, complete: create }), 1);
  assert.ok(lifeWillingness(persona, now) > before);
  assert.equal(lifeStatus(now).profiles[0].goals[0].condition, '双方确认照片已经选完');
  assert.equal(lifeStatus(now).willingness.length, 24);
  assert.match(observe(chat, [wrongPerson], now + 1000), /虚拟日常/);
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
