// Feature attribution is independent of the original source ledger and model/vendor pricing.
export const FEATURE_LABELS = Object.freeze({ chat: '聊天', hippocampus: '海马消化',
  'personality-extract': '人格提取', 'personality-review': '人格核验',
  'living-memory': '长期记忆提炼', 'memory-consolidation': '记忆整理',
  'group-digest': '群日报', 'admin-briefing': '管理员早报',
  perception: '感知唤醒', subagent: '子代理', external: '其他后台', unattributed: '历史未分类' });

export function usageFeature(source = '', feature = '') {
  if (Object.hasOwn(FEATURE_LABELS, feature)) return feature;
  if (Object.hasOwn(FEATURE_LABELS, source)) return source;
  return { 'memory-summary': 'memory-consolidation', 'semantic-memory': 'living-memory', 'background-scan': 'memory-consolidation' }[source] || 'external';
}

export function addFeatureUsage(features, key, { totalTokens = 0, calls = 0, cost = 0, unpriced = false } = {}) {
  const previous = features[key] || {};
  features[key] = { tokens: (Number(previous.tokens) || 0) + (Number(totalTokens) || 0),
    calls: (Number(previous.calls) || 0) + (Number(calls) || 0),
    cost: (Number(previous.cost) || 0) + (Number(cost) || 0),
    unpricedCalls: (Number(previous.unpricedCalls) || 0) + (unpriced ? 1 : 0) };
}

/** Preserve pre-upgrade totals without inventing historical attribution. Never mutate input. */
export function featureSnapshot(data = {}) {
  const result = {};
  for (const [key, value] of Object.entries(data.byFeature || {})) {
    if (Object.hasOwn(FEATURE_LABELS, key) && value && typeof value === 'object') result[key] = { ...value };
  }
  const classified = Object.values(result).reduce((sum, row) => ({ tokens: sum.tokens + (Number(row.tokens) || 0), cost: sum.cost + (Number(row.cost) || 0) }), { tokens: 0, cost: 0 });
  const tokens = Math.max(0, (Number(data.totalTokens) || 0) - classified.tokens);
  const cost = Math.max(0, (Number(data.estimatedYuan) || 0) - classified.cost);
  if (tokens || cost > 1e-10) addFeatureUsage(result, 'unattributed', { totalTokens: tokens, cost });
  return result;
}
