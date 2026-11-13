export function registerPersonHistoryRoutes(router, { store, json }) {
  router.add('GET', '/api/history/person', async (_req, res, _params, url) => {
    const userId = String(url.searchParams.get('userId') || '');
    if (!/^\d{1,15}$/.test(userId)) return json(res, 400, { error: '请输入数字QQ号' });
    const scope = url.searchParams.get('scope') || 'all';
    if (!['all', 'group', 'private'].includes(scope)) return json(res, 400, { error: '会话类型无效' });
    return json(res, 200, store.searchPersonHistory({ userId, scope,
      query: url.searchParams.get('query') || '', limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }));
  });
}
