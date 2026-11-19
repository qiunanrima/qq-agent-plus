import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qqa-life-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { updateConfig } = await import('../src/core/config.js');
const { lifeStatus, observeLife, linkedMemories, claimInitiative, reflectLife, backupLife, clearLife } = await import('../src/character-life/index.js');
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
