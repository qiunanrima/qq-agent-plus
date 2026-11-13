// #13 记忆可见性：默认=现状（回归）；perChat 只留本会话来源；群聊 hidePrivateInGroup 剔除私聊来源；
// memory_query（MemoryStore.query）与提示词同策略。
// 变异对照：把 impressionVisible 改成恒 true（perChat / hidePrivateInGroup 用例必红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-visibility-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { MemoryStore } = await import('../src/memory/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

// 造一个"同一人、两个来源"的旧式人物记忆（迁移后每条印象自带 entry 级 sourceChatKeys）
const memoryRoot = path.join(root, 'memory');
fs.mkdirSync(path.join(memoryRoot, 'group_100'), { recursive: true });
fs.mkdirSync(path.join(memoryRoot, 'private_12345'), { recursive: true });
fs.writeFileSync(path.join(memoryRoot, 'group_100', '12345.json'), JSON.stringify({
  userId: '12345', name: 'Alice', impressions: [{ content: '喜欢 C++', createdAt: 100 }], updatedAt: 100
}), 'utf8');
fs.writeFileSync(path.join(memoryRoot, 'private_12345', '12345.json'), JSON.stringify({
  userId: '12345', name: 'Alice', impressions: [{ content: '正在准备面试', createdAt: 200 }], updatedAt: 200
}), 'utf8');

const withVisibility = (visibility) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.forgettingEnabled = false; // 此组只验证可见性，1970年夹具不参与遗忘排序。
  cfg.memory.visibility = visibility;
  setRuntimeConfig(cfg);
  return new MemoryStore();
};

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

test('默认配置（global + 不隐藏）：两个来源都进提示词与 memory_query —— 与历史行为一致', () => {
  const memory = withVisibility({ mode: 'global', hidePrivateInGroup: false });
  const prompt = memory.formatForPrompt('group:999', { userIds: ['12345'] });
  assert.match(prompt, /喜欢 C\+\+/, 'A 群来源的印象在默认策略下哪都能看到');
  assert.match(prompt, /正在准备面试/, '私聊来源的印象在默认策略下同样可见');
  const q = memory.query('group:999');
  assert.deepEqual(new Set(q.memberImpression.map((e) => e.content)), new Set(['喜欢 C++', '正在准备面试']));
});

test('perChat：只保留来源含当前会话的印象（提示词 + memory_query 同一策略）', () => {
  const memory = withVisibility({ mode: 'perChat', hidePrivateInGroup: false });
  const inGroup100 = memory.formatForPrompt('group:100', { userIds: ['12345'] });
  assert.match(inGroup100, /喜欢 C\+\+/);
  assert.ok(!inGroup100.includes('正在准备面试'), '别的会话来源的印象不得注入');
  assert.equal(memory.formatForPrompt('group:999', { userIds: ['12345'] }), '', '当前会话没有来源 → 整块不注入');
  assert.deepEqual(memory.query('group:100').memberImpression.map((e) => e.content), ['喜欢 C++']);
  assert.deepEqual(memory.query('group:999').memberImpression, [], 'memory_query 同策略');
  assert.deepEqual(memory.query('private:12345').memberImpression.map((e) => e.content), ['正在准备面试']);
});

test('hidePrivateInGroup：群聊剔除私聊来源，私聊里照常可见（global 模式下）', () => {
  const memory = withVisibility({ mode: 'global', hidePrivateInGroup: true });
  const groupPrompt = memory.formatForPrompt('group:100', { userIds: ['12345'] });
  assert.match(groupPrompt, /喜欢 C\+\+/);
  assert.ok(!groupPrompt.includes('正在准备面试'), '群聊里不展示私聊来源的印象');
  const privatePrompt = memory.formatForPrompt('private:12345', { userIds: ['12345'] });
  assert.match(privatePrompt, /正在准备面试/, '私聊里照常可见');
  assert.match(privatePrompt, /喜欢 C\+\+/, '群来源的印象在私聊里不受影响');
  assert.deepEqual(memory.query('group:100').memberImpression.map((e) => e.content), ['喜欢 C++']);
});

test('坏配置回落：mode 写错/缺字段一律按 global + 不隐藏（不改行为）', () => {
  const memory = withVisibility({ mode: 'oops', hidePrivateInGroup: 'yes' });
  const prompt = memory.formatForPrompt('group:999', { userIds: ['12345'] });
  assert.match(prompt, /正在准备面试/, '非法 mode 必须回落 global（不能被当成 perChat）');
  assert.match(prompt, /喜欢 C\+\+/);
});
