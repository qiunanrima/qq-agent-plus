import { resolvePersona } from '../personas.js';
import { personaKey } from './hippocampus.js';
import { impressionVisible, memoryVisibilityOf } from '../core/memory-visibility.js';

/** Console-only, local inspection. No model/embedding calls and no reinforcement. */
export function memoryInsights({ memory, personalityMemory, config, chatKey, query = '' }) {
  const persona = resolvePersona(config, chatKey), key = personaKey(persona);
  const policy = memoryVisibilityOf(config);
  const visibleSources = sources => sources.every(source => impressionVisible({ sourceChatKeys: [source] }, chatKey, policy));
  const cards = (memory.hippocampus?.cards({ persona, chatKey }) || []).map(row => ({ ...row,
    origin: 'hippocampus', scope: `${key}:${row.kind}`, sourceChatKeys: JSON.parse(row.sources || '[]') }));
  if (personalityMemory?.applies(chatKey)) cards.push(...personalityMemory.recallRows({ persona, chatKey }).map(row => ({ ...row,
    title: row.topic, origin: 'personality', scope: `${key}:personality` })));
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  const available = cards.map(row => ({ id: row.id, kind: row.kind, origin: row.origin,
    title: row.title, content: row.content, status: row.status || 'active', sourceChatKeys: row.sourceChatKeys,
    ...memory.forgetting.describe(row.scope, row),
    lexicalMatches: terms.filter(term => `${row.title}\n${row.content}`.toLocaleLowerCase().includes(term)).length }));
  const entries = available
    .filter(row => !terms.length || row.lexicalMatches > 0)
    .sort((a, b) => b.retention - a.retention);
  return { chatKey, query, scoring: '本地长期记忆按保留率排序；关键词用于筛选。R=e^(-t/S)，S随实际使用次数增长；保留率低于0.05不进入自动索引，显式查询仍可读取。',
    entries: entries.slice(0, 60), total: entries.length,
    events: memory.forgetting.recentTrace(chatKey).map(event => ({ ...event,
      entries: event.entries.flatMap(row => {
        const current = available.find(item => row.recallId ? item.recallId === row.recallId : item.id === row.id);
        if (!current || !visibleSources(row.sourceChatKeys || [])) return [];
        return [{ ...row, title: current.title, sourceChatKeys: current.sourceChatKeys }];
      }) })) };
}

export function registerMemoryInsightRoutes(router, { json, getConfig, memory, orchestrator }) {
  router.add('GET', '/api/memory/insights', (req, res, params, url) => {
    const chatKey = String(url.searchParams.get('chatKey') || '');
    if (!/^(group|private):\d{1,15}$/.test(chatKey)) return json(res, 400, { error: '需要有效的QQ会话' });
    try { return json(res, 200, memoryInsights({ memory, personalityMemory: orchestrator.personalityMemory,
      config: getConfig(), chatKey, query: String(url.searchParams.get('query') || '').slice(0, 120) })); }
    catch (error) { return json(res, 500, { error: String(error.message || error) }); }
  });
}
