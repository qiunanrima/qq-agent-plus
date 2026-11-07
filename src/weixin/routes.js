export function registerWeixinRoutes(router, { runtime, json, readBody, getConfig, updateConfig, auditWrite }) {
  router.add('GET', '/api/weixin/status', async (_req, res) => json(res, 200, runtime.status()));
  const action = (path, label, execute) => router.add('POST', `/api/weixin/${path}`, async (req, res, params) => {
    const body = await readBody(req);
    try {
      // Do not record credentials, QR values, verification codes or message text.
      await auditWrite(`weixin.${label}`, 'weixin', { req });
      return json(res, 200, await execute(body, params));
    } catch { return json(res, 400, { error: '微信操作失败，请确认状态、输入和网络；账号更换前需先解除连接' }); }
  });
  action('lifecycle', 'lifecycle', async body => {
    if (typeof body.enabled !== 'boolean' || typeof body.graduated !== 'boolean') throw new Error('Invalid lifecycle');
    updateConfig({ weixin: { enabled: body.enabled, graduated: body.graduated } });
    await runtime.sync(); return { config: { weixin: getConfig().weixin } };
  });
  action('login', 'login', () => runtime.beginLogin());
  action('login/:id', 'login-poll', (body, params) => runtime.pollLogin(params.id, body.verifyCode || ''));
  action('peers/:id', 'peer-change', async (body, params) => {
    if (body.confirm !== true) throw new Error('请确认身份绑定和权限变更');
    await runtime.configurePeer(params.id, body); return { ok: true };
  });
  action('disconnect', 'disconnect', async body => {
    if (body.confirm !== true) throw new Error('请确认解除连接');
    await runtime.disconnect(); return { ok: true };
  });
  action('outbox/:id', 'send-resolution', async (body, params) => {
    if (body.confirm !== true) throw new Error('请先在微信中核对发送结果');
    runtime.resolveSend(params.id, body.sent); return { ok: true };
  });
}
