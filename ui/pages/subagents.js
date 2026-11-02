import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { QARegistry } from '../core/registry.js';

function renderSubagentExperiment(c) {
  const config = c.subagent || {};
  return `<div class="experiment-card" id="experiment-subagent">
    <div class="experiment-card-main"><strong>受限子代理</strong>
      <p>委派独立上下文检索网页、角色背景和可见记忆，只返回资料。不能发消息、写入或递归；调用过程记入运行日志。</p>
      <small>${config.enabled ? '已启用' : '已停用'} · ${config.graduated ? '已固化' : '实验中'}</small></div>
    <div class="experiment-card-side"><label class="checkbox-row"><input type="checkbox" id="subagent-enabled" ${config.enabled ? 'checked' : ''}>启用</label>
      <button type="button" class="btn btn-small" id="subagent-graduate">${config.graduated ? '取消固化' : '固化上线'}</button></div>
  </div>`;
}

function bindSubagentExperiment() {
  const save = async (patch) => {
    const response = await api('/api/config', { method: 'POST', body: JSON.stringify({ subagent: patch }) });
    state.config = response.config || state.config;
    const card = $('#experiment-subagent');
    if (card) card.outerHTML = renderSubagentExperiment(state.config || {});
    bindSubagentExperiment();
  };
  const failed = (error) => {
    const status = $('#experiment-launch-result');
    if (status) status.textContent = `子代理设置保存失败：${error.message}`;
  };
  $('#subagent-enabled')?.addEventListener('input', (event) => event.stopPropagation());
  $('#subagent-enabled')?.addEventListener('change', async (event) => {
    event.stopPropagation();
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try { await save({ enabled: toggle.checked }); }
    catch (error) { toggle.checked = !toggle.checked; failed(error); }
    finally { toggle.disabled = false; }
  });
  $('#subagent-graduate')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const graduated = state.config?.subagent?.graduated === true;
    if (!await askForConfirmation(graduated ? '取消固化并停用受限子代理？正在运行的子代理会取消，日志保留。'
      : '固化并启用受限子代理？它只能检索资料，共享聊天预算，调用过程写入运行日志。')) return;
    button.disabled = true;
    try { await save({ enabled: !graduated, graduated: !graduated }); }
    catch (error) { failed(error); }
    finally { button.disabled = false; }
  });
}

QARegistry.onAfter('renderSettings', bindSubagentExperiment);
export { renderSubagentExperiment, bindSubagentExperiment };
