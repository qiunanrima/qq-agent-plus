import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { renderSettings } from '../app.js';

function renderModelFallbackExperiment(c = {}) {
  const cfg = c.modelFallback || {};
  return `<div class="experiment-card" data-independent-save><div class="experiment-card-main"><strong>模型自动回退</strong><p>${cfg.enabled ? '已启用' : '已停用'} · ${esc((cfg.order || ['agy', 'codex', 'api']).join(' → '))}</p></div><div class="experiment-card-side"><button class="btn btn-small" id="model-fallback-open">回退设置</button><button class="btn btn-small" id="model-fallback-toggle">${cfg.enabled ? '停用' : '启用'}</button><button class="btn btn-small" id="model-fallback-graduate">${cfg.graduated ? '取消固化' : '固化上线'}</button></div></div>`;
}
function renderModelFallbackSection(c = {}) {
  const cfg = c.modelFallback || {};
  const order = cfg.order || ['agy', 'codex', 'api'];
  return `<h3>模型自动回退</h3><p>${cfg.enabled ? '已启用' : '已停用'}。每次请求从首选后端开始，跳过未启用或未配置的后端。辅助请求继续使用原配置。</p>
  <p class="hint">任一宿主工具开始执行后，失败也不会切换后端，避免重复发送或重复操作。取消、权限撤销和时间限制不会触发回退。停用不会删除顺序；同时开启两个 CLI 时，请先停用其中一个再关闭回退。</p>
  <div id="model-fallback-order">${order.map((name, i) => `<div class="field"><strong>${i + 1}. ${esc(name)}</strong> <button class="btn btn-small" data-fallback-move="${i}" data-direction="-1" ${i === 0 ? 'disabled' : ''}>上移</button> <button class="btn btn-small" data-fallback-move="${i}" data-direction="1" ${i === order.length - 1 ? 'disabled' : ''}>下移</button></div>`).join('')}</div>
  <p class="hint">调整立即保存。agy、Codex 使用各自设置中的模型；api 使用「模型 API」当前配置及其备用模型。多模态请求跳过仅支持文字的 CLI。</p><p id="model-fallback-result" role="status"></p>`;
}
async function saveModelFallback(patch) {
  const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ modelFallback: patch }) });
  state.config = result.config || await api('/api/config');
}
function bindModelFallbackSettings() {
  const bind = (selector, action) => $(selector)?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await action(); renderSettings(); }
    catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  });
  bind('#model-fallback-open', () => { state.settingsSection = 'model-fallback'; });
  bind('#model-fallback-toggle', () => saveModelFallback({ enabled: !state.config?.modelFallback?.enabled }));
  bind('#model-fallback-graduate', () => saveModelFallback({ graduated: !state.config?.modelFallback?.graduated }));
  for (const button of document.querySelectorAll('[data-fallback-move]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const order = [...(state.config?.modelFallback?.order || ['agy', 'codex', 'api'])];
      const i = Number(button.dataset.fallbackMove), j = i + Number(button.dataset.direction);
      [order[i], order[j]] = [order[j], order[i]];
      try { await saveModelFallback({ order }); renderSettings(); }
      catch (error) { alert(error.message); button.disabled = false; }
    });
  }
}
export { renderModelFallbackExperiment, renderModelFallbackSection, bindModelFallbackSettings };
