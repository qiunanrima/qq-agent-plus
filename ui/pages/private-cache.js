import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { QARegistry } from '../core/registry.js';

function renderPrivateCacheExperiment(c) {
  const config = c.privateCache || {};
  return `<div class="experiment-card" id="experiment-private-cache">
    <div class="experiment-card-main"><strong>私聊分块缓存</strong>
      <p>独立 QQ 私聊的历史窗口填满后，按块移动起点，移出最早的一小段，至少保留当前窗口四分之三的记录。可在用量页比较未缓存输入。</p>
      <small>${config.enabled ? '已启用' : '已停用'} · ${config.graduated ? '已固化' : '实验中'}</small></div>
    <div class="experiment-card-side"><label class="checkbox-row"><input type="checkbox" id="private-cache-enabled" ${config.enabled ? 'checked' : ''}>启用</label>
      <button type="button" class="btn btn-small" id="private-cache-graduate">${config.graduated ? '取消固化' : '固化'}</button></div>
  </div>`;
}

function bindPrivateCacheExperiment() {
  const save = async (patch) => {
    const response = await api('/api/config', { method: 'POST', body: JSON.stringify({ privateCache: patch }) });
    state.config = response.config || state.config;
    const card = $('#experiment-private-cache');
    if (card) card.outerHTML = renderPrivateCacheExperiment(state.config || {});
    bindPrivateCacheExperiment();
  };
  const failed = (error) => {
    const status = $('#experiment-launch-result');
    if (status) status.textContent = `缓存设置保存失败：${error.message}`;
  };
  $('#private-cache-enabled')?.addEventListener('input', (event) => event.stopPropagation());
  $('#private-cache-enabled')?.addEventListener('change', async (event) => {
    event.stopPropagation();
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try { await save({ enabled: toggle.checked }); }
    catch (error) { toggle.checked = !toggle.checked; failed(error); }
    finally { toggle.disabled = false; }
  });
  $('#private-cache-graduate')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const graduated = state.config?.privateCache?.graduated === true;
    if (!await askForConfirmation(graduated ? '取消固化私聊分块缓存？'
      : '固化私聊分块缓存？')) return;
    button.disabled = true;
    try { await save({ graduated: !graduated }); }
    catch (error) { failed(error); }
    finally { button.disabled = false; }
  });
}

QARegistry.onAfter('renderSettings', bindPrivateCacheExperiment);
export { renderPrivateCacheExperiment, bindPrivateCacheExperiment };
