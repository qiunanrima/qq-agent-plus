import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { QARegistry } from '../core/registry.js';
import { state } from '../core/state.js';

function browserFetchState(config) {
  return (config.enabled === true ? '已启用' : '已停用') + (config.graduated === true ? ' · 已固化' : ' · 实验中');
}

function renderWebFetchBrowserExperiment(c) {
  const config = c.webFetchBrowser || {};
  return `<div class="experiment-card" id="experiment-web-fetch-browser">
    <div class="experiment-card-main"><strong>网页抓取 · Obscura</strong>
      <p>按需渲染依赖 JavaScript 的网页正文。每次最多运行一个浏览器进程。</p>
      <small id="web-fetch-browser-state">${browserFetchState(config)}</small></div>
    <div class="experiment-card-side"><label class="checkbox-row">
      <input type="checkbox" id="web-fetch-browser-enabled" ${config.enabled === true ? 'checked' : ''}>启用
    </label></div>
  </div>`;
}

function bindWebFetchBrowserExperiment() {
  const toggle = $('#web-fetch-browser-enabled');
  if (!toggle) return;
  toggle.addEventListener('input', event => event.stopPropagation());
  toggle.addEventListener('change', async (event) => {
    event.stopPropagation();
    const enabled = toggle.checked;
    const status = $('#experiment-launch-result');
    toggle.disabled = true;
    try {
      const response = await api('/api/config', {
        method: 'POST', body: JSON.stringify({ webFetchBrowser: { enabled } })
      });
      state.config = response.config || state.config;
      const config = state.config?.webFetchBrowser || {};
      const label = $('#web-fetch-browser-state');
      if (label) label.textContent = browserFetchState(config);
      if (status) status.textContent = '';
    } catch (error) {
      toggle.checked = !enabled;
      if (status) status.textContent = `网页抓取实验设置保存失败：${error.message}`;
    } finally {
      toggle.disabled = false;
    }
  });
}

QARegistry.onAfter('renderSettings', bindWebFetchBrowserExperiment);
export { renderWebFetchBrowserExperiment, bindWebFetchBrowserExperiment };
