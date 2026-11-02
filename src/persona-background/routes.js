import { resolvePersona } from '../personas.js';

export function registerPersonaBackgroundRoutes({ router, background, getConfig, readBody, json }) {
  const handle = (remove = false, write = false) => async (req, res, _params, url) => {
    try {
      const chatKey = String(url?.searchParams.get('chatKey') || '');
      const body = write ? await readBody(req) : null;
      const persona = resolvePersona(getConfig(), chatKey);
      const doc = write ? background.save(persona, body || {}, remove) : background.read(persona);
      return json(res, 200, { ok: true, ...doc,
        sections: doc.sections.map(({ id, title }) => ({ id, title })) });
    } catch (error) {
      const status = error.statusCode || error.httpStatus || 500;
      return json(res, status, { ok: false, error: status < 500 ? error.message : '背景文档读写失败，请检查服务日志与数据目录权限' });
    }
  };
  router.add('GET', '/api/persona-background', handle());
  router.add('POST', '/api/persona-background', handle(false, true));
  router.add('DELETE', '/api/persona-background', handle(true, true));
}
