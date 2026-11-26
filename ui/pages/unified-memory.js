import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation, syncGraduatedFeatureNavigation } from '../core/dom-util.js';
import { state } from '../core/state.js';

const kindNames = { agreement: '约定', preference: '偏好', task: '任务', experience: '经历', relationship: '关系' };

function renderUnifiedExperiment(c) {
  return `<div class="experiment-card" id="experiment-unified-memory">
    <div class="experiment-card-main"><strong>统一记忆</strong><p>在回复中使用当前约定、工作进度和共同经历。</p></div>
    <div class="experiment-card-side"><label><input id="unified-enabled" type="checkbox" ${c.memory?.unifiedEnabled ? 'checked' : ''}>启用</label>
    <button type="button" id="unified-graduate" class="btn btn-small">${c.memory?.unifiedGraduated ? '取消固化' : '固化上线'}</button></div>
    <small role="status"></small></div>`;
}

function bindUnifiedExperiment() {
  const card = $('#experiment-unified-memory');
  if (!card) return;
  async function save(patch) {
    const inputs = card.querySelectorAll('input,button');
    inputs.forEach(input => { input.disabled = true; });
    try {
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ memory: patch }) });
      state.config = result.config;
      syncGraduatedFeatureNavigation(state.config);
      card.outerHTML = renderUnifiedExperiment(state.config);
      bindUnifiedExperiment();
    } catch (error) {
      card.querySelector('small').textContent = error.message;
      card.querySelector('input').checked = state.config?.memory?.unifiedEnabled === true;
      inputs.forEach(input => { input.disabled = false; });
    }
  }
  const toggle = card.querySelector('input');
  toggle.oninput = event => event.stopPropagation();
  toggle.onchange = event => { event.stopPropagation(); void save({ unifiedEnabled: toggle.checked }); };
  card.querySelector('button').onclick = async () => {
    const next = !state.config?.memory?.unifiedGraduated;
    if (await askForConfirmation(next ? '在控制台导航显示统一记忆？' : '隐藏统一记忆导航入口？')) {
      await save({ unifiedGraduated: next });
    }
  };
}

async function loadUnifiedMemoryPage() {
  const box = $('#unified-memory-page');
  if (!box) return;
  box.innerHTML = '<h2>统一记忆</h2><p role="status">读取中…</p>';
  const status = box.querySelector('p');
  try {
    const data = await api('/api/unified-memory/status');
    if (!status.isConnected) return;
    status.textContent = data.enabled ? '记忆已启用' : '记忆已停用';
    if (!data.scopes.length) { status.textContent += ' · 暂无记录'; return; }
    box.insertAdjacentHTML('beforeend', `<label>会话 <select>${data.scopes.map(row =>
      `<option value="${esc(row.scope)}">${esc(row.scope)}</option>`).join('')}</select></label><div data-records></div>`);
    const select = box.querySelector('select'), list = box.querySelector('[data-records]');
    let request = 0;
    async function show(offset = 0, record = null) {
      const sequence = ++request;
      const query = new URLSearchParams({ scope: select.value, offset: String(offset) });
      if (record) { query.set('kind', record.kind); query.set('subject', record.subject); }
      try {
        const { records, total } = await api('/api/unified-memory/records?' + query);
        if (sequence !== request || !list.isConnected) return;
        list.innerHTML = `${record ? '<button class="btn" data-back>返回当前记录</button>' : ''}
          ${records.map((row, i) => `<article class="panel"><strong>${esc(kindNames[row.kind || record?.kind])} · ${esc(row.body.topic || '未命名')}</strong>
          <p>${esc(row.body.summary || '')}</p>${row.body.nextStep ? `<p>下一步　${esc(row.body.nextStep)}</p>` : ''}
          <small>${row.closed ? '已关闭 · ' : ''}${esc(new Date(row.timestamp).toLocaleString())} · ${esc(row.source)}</small>
          ${record ? '' : `<button class="btn btn-small" data-revision="${i}">修订历史</button>`}</article>`).join('') || '<p>暂无记录</p>'}
          ${offset ? '<button class="btn" data-prev>上一页</button>' : ''}
          ${offset + records.length < total ? '<button class="btn" data-next>下一页</button>' : ''}`;
        list.querySelector('[data-back]')?.addEventListener('click', () => show());
        list.querySelector('[data-prev]')?.addEventListener('click', () => show(offset - 50, record));
        list.querySelector('[data-next]')?.addEventListener('click', () => show(offset + 50, record));
        list.querySelectorAll('[data-revision]').forEach(btn => btn.onclick = () => show(0, records[Number(btn.dataset.revision)]));
      } catch (error) { if (sequence === request) list.textContent = error.message; }
    }
    select.onchange = () => show();
    await show();
  } catch (error) { status.textContent = error.message; }
}

export { renderUnifiedExperiment, bindUnifiedExperiment, loadUnifiedMemoryPage };
