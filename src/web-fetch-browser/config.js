export const WEB_FETCH_BROWSER_DEFAULTS = Object.freeze({ enabled: false, graduated: false });

export function normalizeWebFetchBrowserConfig(raw) {
  return { enabled: raw?.enabled === true, graduated: raw?.graduated === true };
}

let activeRender = null;

export function tryStartWebFetchBrowser(config) {
  if (config.webFetchBrowser?.enabled !== true || config.webSearch?.enabled === false || activeRender) return null;
  const controller = new AbortController();
  activeRender = controller;
  return {
    signal: controller.signal,
    release() { activeRender = null; }
  };
}

export function syncWebFetchBrowser(config) {
  if (config.webFetchBrowser?.enabled !== true || config.webSearch?.enabled === false) activeRender?.abort();
}
