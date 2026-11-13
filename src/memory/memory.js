// 统一记忆入口：人物长期记忆全局化；会话 handoff 仍按 chatKey 隔离。
import { MemoryStore as BaseMemoryStore } from './memory-global.js';
import { bindGlobalMemoryStore } from './memory-runtime-integration.js';
import { backupPersonBeforeConsolidation } from './memory-consolidation-backup.js';
import '../pilots/relationship-runtime-integration.js';
import { impressionVisible, memoryVisibilityOf } from '../core/memory-visibility.js';
import { sanitizeUserText } from '../core/util.js';
import { resolvePersona } from '../personas.js';
import { getConfig } from '../core/config.js';
import { tokenizeText } from './memory-search.js';
import { personaKey } from './hippocampus.js';

export class MemoryStore extends BaseMemoryStore {
  constructor(...args) {
    super(...args);
    // 启动时立即完成旧人物记忆迁移，确保 IdentityStore 随后的 rebuild
    // 看不到旧 group_*/<QQ>.json，从而不再维护第二份 legacy_memory_refs 内容。
    this.people.listSourceChats();
    bindGlobalMemoryStore(this);
  }

  /** 全局人物列表：不再按 chatKey 过滤。 */
  globalMembers() {
    return this.people.members();
  }

  search(chatKey, query, options = {}) {
    const found = super.search(chatKey, query, options);
    if (!this.hippocampus.enabled() || !String(query || '').trim()) return found;
    const terms = new Set(tokenizeText(query));
    const cards = this.hippocampus.cards({ persona: resolvePersona(getConfig(), chatKey), chatKey })
      .filter((r) => r.kind === 'person' && (!options.userId || r.subject === String(options.userId)))
      .map((r) => {
        const tokens = new Set(tokenizeText(r.content));
        const score = [...terms].filter((term) => tokens.has(term)).length / Math.max(1, terms.size);
        return { userId: r.subject, target: r.subject, content: sanitizeUserText(r.content),
          origin: 'hippocampus', lastObservedAt: r.updated, sourceChatKeys: JSON.parse(r.sources), score };
      }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    // 各检索器的分数尺度不同，交替取结果，避免某个库永远挤掉另一个库。
    const results = [], seen = new Set();
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    for (let i = 0; i < Math.max(cards.length, found.results.length) && results.length < limit; i++) {
      for (const row of [cards[i], found.results[i]]) {
        if (!row || results.length >= limit) continue;
        const key = `${row.userId}:${row.content}`;
        if (!seen.has(key)) { seen.add(key); results.push(row); }
      }
    }
    const scope = personaKey(resolvePersona(getConfig(), chatKey));
    const weights = new Map(results.map(row => [row, this.forgetting.describe(
      row.origin === 'hippocampus' ? `${scope}:person` : 'legacy:person', row).retention]));
    results.sort((a, b) => {
      // Explicit history search keeps cold results eligible; relevance dominates the decay tie-break.
      return (b.score || 0) * (0.8 + 0.2 * weights.get(b)) - (a.score || 0) * (0.8 + 0.2 * weights.get(a));
    });
    return { ...found, results, total: results.length };
  }

  /**
   * memory_query 的底层查询：全局人物记忆，受 memory.visibility 策略约束（#13）——
   * mode='perChat' 只返回来源含当前会话的印象；hidePrivateInGroup 时群聊里剔除私聊来源。
   * 默认（global + 不隐藏）与历史行为逐字一致。
   */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const vis = memoryVisibilityOf();
    const memberImpression = [];
    if (this.hippocampus.enabled()) {
      for (const row of this.hippocampus.cards({ persona: resolvePersona(getConfig(), chatKey), chatKey })) {
        if (row.kind !== 'person') continue;
        memberImpression.push({ userId: row.subject, target: row.subject, content: sanitizeUserText(row.content),
          createdAt: row.updated, lastObservedAt: row.updated, origin: 'hippocampus', sourceChatKeys: JSON.parse(row.sources) });
      }
    }
    for (const member of this.people.members()) {
      for (const entry of member.impressions || []) {
        if (!impressionVisible(entry, chatKey, vis)) continue;
        memberImpression.push({
          userId: String(member.userId || ''),
          target: String(member.name || member.userId || '某人'),
          // 印象正文是群聊内容的沉淀：出工具口前过一道段头弱化（与 memory-global 同口径）
          content: sanitizeUserText(entry.content),
          createdAt: entry.createdAt,
          lastObservedAt: entry.lastObservedAt,
          origin: entry.origin || '',
          sourceChatKeys: Array.isArray(entry.sourceChatKeys) ? [...entry.sourceChatKeys] : []
        });
      }
    }
    memberImpression.sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return { memberImpression };
  }

  /**
   * 全局人物记忆的 replace 是潜在破坏性写入。
   * 当该人物已经拥有当前 chatKey 的来源记录时，BaseMemoryStore.replace 会用新摘要替换
   * 现有全局印象；因此在写入前保存完整人物快照。若人物只是第一次出现在一个新 chat，
   * 基础实现会做 merge 而不是覆盖，此时不制造无意义备份。
   */
  replaceMember(chatKey, userId, name, contents, options = {}) {
    const source = String(chatKey || '').trim();
    const person = this.getMember('', userId);
    const destructive = Array.isArray(person?.impressions)
      && person.impressions.length > 0
      && Array.isArray(person?.sourceChatKeys)
      && person.sourceChatKeys.includes(source);
    if (destructive) {
      backupPersonBeforeConsolidation(person, {
        sourceChatKey: source,
        at: Date.now()
      });
    }
    return super.replaceMember(chatKey, userId, name, contents, options);
  }

  /**
   * 显式 consolidation 入口，供后续调用方使用；避免通过普通 replace 语义猜测意图。
   * 当前 Orchestrator 的历史实现仍直接调用 replaceMember，因此上面的写前保护是必要兜底。
   */
  replaceMemberForConsolidation(chatKey, userId, name, contents, options = {}) {
    const person = this.getMember('', userId);
    backupPersonBeforeConsolidation(person, {
      sourceChatKey: chatKey,
      at: Date.now()
    });
    return super.replaceMember(chatKey, userId, name, contents, { origin: 'consolidated', ...options });
  }

  /**
   * 兼容批量 replaceConsolidated 调用。破坏前快照**不要**在这里拍：
   * 中间层的 replaceConsolidated 最终走 this.replaceMember（回到本类覆写），
   * 对"真的会被覆盖"的人自带快照；在这里再拍一遍会让每人每次整理落两份一样的
   * 快照，KEEP_PER_PERSON=20 的实际深度只剩约 10 轮（2026-09-25 复核定案）。
   */
  replaceConsolidated(chatKey, next) {
    return super.replaceConsolidated(chatKey, next);
  }
}
