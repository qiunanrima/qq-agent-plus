import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietPrivateChat, selfWakeAllowed, privateInitiativeAllowed, proactiveScopeProbability, PRIVATE_INITIATIVE_COOLDOWN_MS } from '../src/core/private-proactive-policy.js';

const cfg = { admin: { ownerUin: '900001' }, proactive: { privateEnabled: true, probability: 0.8 } };
test('群聊和私聊概率独立，旧配置的私聊默认5%，0保持关闭', () => {
  assert.equal(proactiveScopeProbability(cfg, 'group'), 0.8);
  assert.equal(proactiveScopeProbability(cfg, 'private'), 0.05);
  assert.equal(proactiveScopeProbability({ proactive: { probability: 1, privateProbability: 0 } }, 'private'), 0);
  assert.equal(proactiveScopeProbability({ proactive: { probability: 0, privateProbability: 0.9 } }, 'private'), 0.9);
  for (const [value, expected] of [[2, 1], [-1, 0], ['bad', 0.05]]) {
    assert.equal(proactiveScopeProbability({ proactive: { privateProbability: value } }, 'private'), expected);
  }
});
test('旧配置即使开启私聊范围也不会主动找非管理员，显式开启后才允许并冷却24小时', () => {
  assert.equal(privateInitiativeAllowed('private:777777', cfg), false);
  assert.equal(privateInitiativeAllowed('private:900001', cfg), true);
  const enabled = { ...cfg, proactive: { ...cfg.proactive, nonAdminPrivateEnabled: true } };
  const now = Date.now();
  assert.equal(privateInitiativeAllowed('private:777777', enabled), true);
  assert.equal(privateInitiativeAllowed('private:777777', enabled, now - PRIVATE_INITIATIVE_COOLDOWN_MS + 1, now), false);
  assert.equal(privateInitiativeAllowed('private:777777', enabled, now - PRIVATE_INITIATIVE_COOLDOWN_MS, now), true);
  assert.equal(privateInitiativeAllowed('private:900001', enabled, now, now), true);
});
test('管理员只认配置QQ，非管理员不自动补话或自安排，群聊与管理员保留能力', () => {
  assert.equal(quietPrivateChat('private:777777', cfg), true);
  assert.equal(quietPrivateChat('private:900001', cfg), false);
  assert.equal(quietPrivateChat('group:900001', cfg), false);
  assert.equal(selfWakeAllowed('private:777777', cfg), false);
  assert.equal(selfWakeAllowed('private:900001', cfg), true);
  assert.equal(selfWakeAllowed('group:1', cfg), true);
  assert.equal(selfWakeAllowed('private:777777', {}), false, '未设置管理员时不扩大豁免');
});
