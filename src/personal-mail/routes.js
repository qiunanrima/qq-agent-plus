import { testPersonalMailConnection } from './index.js';
import { credentials, personalMailSettings } from './settings.js';

export function registerPersonalMailRoutes(router, {
  json, readBody, auditWrite, settings = personalMailSettings, testConnection = testPersonalMailConnection
}) {
  router.add('GET', '/api/personal-mail', async (_req, res) => {
    return json(res, 200, { providers: settings.status() });
  });

  router.add('POST', '/api/personal-mail/:provider', async (req, res, { provider }) => {
    if (!Object.hasOwn(credentials, provider)) return json(res, 404, { error: '邮箱类型不存在' });
    const input = await readBody(req, 24 * 1024);
    const error = settings.update(provider, input);
    if (error) return json(res, 400, { error });
    auditWrite('personal-mail.settings', provider, { req, after: { enabled: input.enabled } });
    return json(res, 200, { provider: settings.status()[provider] });
  }, { keyEndpoint: true });

  router.add('POST', '/api/personal-mail/:provider/test', async (req, res, { provider }) => {
    if (!Object.hasOwn(credentials, provider)) return json(res, 404, { error: '邮箱类型不存在' });
    const status = await testConnection(provider, { env: settings.runtimeEnv({ includeDisabled: true }) });
    auditWrite('personal-mail.test', provider, { req, ok: status === 'ok' });
    return json(res, 200, { status });
  }, { keyEndpoint: true });
}
