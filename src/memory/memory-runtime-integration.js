import { IdentityStore } from '../identity/identity-store.js';
import { safeSlice, sanitizeUserText } from '../core/util.js';
import { visibleImpressions, memoryVisibilityOf } from '../core/memory-visibility.js';

let activeMemoryStore = null;
let patched = false;

/**
 * @param userId 目标 QQ
 * @param maxMemories 最多几条
 * @param chatKey 当前会话（形如 group:<群号> / private:<QQ号>）。
 *   必须传：`person_memory_lookup` 工具自述"只返回当前会话可见的旧印象"，而
 *   memory.visibility 的 perChat / hidePrivateInGroup 都是按 chatKey 判可见性的 ——
 *   不传就等于绕过策略（2026-09-30 审查 P1）。
 *   **空串 = 管理视图**（无"当前会话"语义）：不做 perChat 过滤，只保留默认策略；
 *   否则控制台人物列表 / 手动好友评分会被某个群的 perChat 策略整片滤空。
 */
function normalizeMemoryView(userId, maxMemories = 6, chatKey = '') {
  if (!activeMemoryStore) {
    return {
      globalMemories: [],
      globalMemoryCount: 0,
      memorySourceChatKeys: []
    };
  }

  const member = activeMemoryStore.getMember('', String(userId || ''));
  const impressions = [...(Array.isArray(member?.impressions) ? member.impressions : [])];
  if (chatKey && activeMemoryStore.hippocampus?.enabled()) {
    const cards = activeMemoryStore.query(chatKey).memberImpression || [];
    for (const entry of cards) {
      if (entry.origin === 'hippocampus' && String(entry.userId) === String(userId)) impressions.push(entry);
    }
  }
  // #13：按 memory.visibility 过滤到「对当前会话可见」的印象（默认策略下与历史逐字一致）。
  // 无 chatKey（管理视图）时只按 global+不隐藏走 —— 等价于不按会话过滤。
  const vis = memoryVisibilityOf();
  const scoped = chatKey ? vis : { ...vis, mode: 'global' };
  const visible = visibleImpressions(impressions, chatKey, scoped);
  const sorted = [...visible]
    .sort((a, b) => (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
  const limit = Math.min(20, Math.max(1, Number(maxMemories) || 6));
  const globalMemories = sorted.slice(0, limit).map((item) => ({
    // 印象正文可能含模型转述的群友【…】段头，下游（好友评估等提示词）不再二次清洗 ——
    // 与 memory-global.js formatForPrompt 的防线保持同一口径，在这里统一收口。
    content: sanitizeUserText(safeSlice(String(item?.content || '').replace(/\s+/g, ' ').trim(), 300)),
    observedAt: Number(item?.lastObservedAt) || Number(item?.createdAt) || 0,
    sourceChatKeys: [...new Set((Array.isArray(item?.sourceChatKeys) ? item.sourceChatKeys : [])
      .map(String)
      .filter(Boolean))]
  })).filter((item) => item.content);

  const memorySourceChatKeys = [...new Set([
    ...(Array.isArray(member?.sourceChatKeys) ? member.sourceChatKeys : []),
    ...globalMemories.flatMap((item) => item.sourceChatKeys)
  ].map(String).filter(Boolean))];

  return {
    globalMemories,
    globalMemoryCount: impressions.length,
    memorySourceChatKeys
  };
}

function attachGlobalMemory(person, maxMemories = 6, chatKey = '') {
  if (!person) return person;
  const memory = normalizeMemoryView(person.userId, maxMemories, chatKey);
  return {
    ...person,
    // 统一记忆字段：IdentityStore 只负责身份；人物长期记忆只从 MemoryStore 读取。
    globalMemories: memory.globalMemories,
    globalMemoryCount: memory.globalMemoryCount,
    memorySourceChatKeys: memory.memorySourceChatKeys,

    // 兼容旧的好友评估/工具消费方。语义已经变为“全局人物记忆”，不再是当前群记忆。
    currentContextMemories: memory.globalMemories.map((item) => ({
      content: item.content,
      observedAt: item.observedAt,
      sourceChatKeys: item.sourceChatKeys
    })),
    currentMemoryCount: memory.globalMemoryCount,
    otherContextMemoryCount: 0,
    legacyMemoryCount: 0
  };
}

function patchIdentityStore() {
  if (patched) return;
  patched = true;

  const originalGetPerson = IdentityStore.prototype.getPerson;
  if (typeof originalGetPerson === 'function') {
    IdentityStore.prototype.getPerson = function getPersonWithGlobalMemory(userId, options = {}) {
      const person = originalGetPerson.call(this, userId, options);
      // chatKey 必须透传：可见性按会话判（perChat / hidePrivateInGroup）。
      return attachGlobalMemory(person, options?.maxMemories, options?.chatKey);
    };
  }

  const originalListPeople = IdentityStore.prototype.listPeople;
  if (typeof originalListPeople === 'function') {
    IdentityStore.prototype.listPeople = function listPeopleWithGlobalMemory(...args) {
      const people = originalListPeople.apply(this, args);
      // 管理视图（控制台人物列表、手动好友评分）没有"当前会话"语义：传空 chatKey，
      // 即按默认策略（global+不隐藏）展示，与历史逐字一致 —— 不该拿某个群的策略过滤管理视图。
      return Array.isArray(people)
        ? people.map((person) => attachGlobalMemory(person, 6, ''))
        : people;
    };
  }
}

export function bindGlobalMemoryStore(store) {
  activeMemoryStore = store || null;
  patchIdentityStore();
}

export function globalMemoryStoreForIdentity() {
  return activeMemoryStore;
}
