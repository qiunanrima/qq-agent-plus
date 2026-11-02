// 只兼容本项目历史工具名，不改变供应商 API 的字段或工具类型。
export function canonicalToolName(name) {
  if (name === 'web_search') return 'search_web';
  if (name === 'web_fetch') return 'fetch_url';
  return String(name || '');
}
