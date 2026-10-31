import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation, syncGraduatedFeatureNavigation } from '../core/dom-util.js';
import { switchTab } from '../app.js';

const labels = { preference: '自身偏好', experience: '共同经历', relationship: '关系变化' };
function renderPersonalityMemoryExperiment(c) {
  const config = c.personalityMemory || {};
  return `<div class="experiment-card" id="experiment-personality-memory">
    <div class="experiment-card-main"><strong>人格成长记忆</strong>
      <p>让角色从真实互动中积累自己的偏好、共同经历和关系变化，核心人设保持不变。</p>
      <small>${config.enabled ? '已启用' : '已停用'} · ${config.graduated ? '已固化' : '实验中'}</small></div>
    <div class="experiment-card-side"><label class="checkbox-row"><input type="checkbox" id="pm-experiment-enabled" ${config.enabled ? 'checked' : ''}>启用</label>
      ${config.graduated ? '<button type="button" class="btn btn-small" id="pm-open">打开人格成长页</button>' : ''}
      <button type="button" class="btn btn-small" id="pm-graduate">${config.graduated ? '取消固化' : '固化上线'}</button></div>
  </div>`;
}

async function patchConfig(patch) {
  const response = await api('/api/config', { method: 'POST', body: JSON.stringify({ personalityMemory: patch }) });
  state.config = response.config || state.config;
  syncGraduatedFeatureNavigation(state.config);
}

function bindPersonalityMemoryExperiment() {
  const redrawCard = () => {
    const card = $('#experiment-personality-memory');
    if (card) card.outerHTML = renderPersonalityMemoryExperiment(state.config || {});
    bindPersonalityMemoryExperiment();
  };
  // 生命周期开关即时保存，不让设置页把它误判为未保存的草稿；其他控件照常追踪。
  $('#pm-experiment-enabled')?.addEventListener('input', (event) => event.stopPropagation());
  $('#pm-experiment-enabled')?.addEventListener('change', async (event) => {
    event.stopPropagation();
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try { await patchConfig({ enabled: toggle.checked }); redrawCard(); }
    catch (error) {
      toggle.checked = !toggle.checked;
      const status = $('#experiment-launch-result');
      if (status) status.textContent = `保存失败：${error.message}`;
    } finally { toggle.disabled = false; }
  });
  $('#pm-open')?.addEventListener('click', () => switchTab('personality-memory'));
  $('#pm-graduate')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const graduated = state.config?.personalityMemory?.graduated === true;
    if (!await askForConfirmation(graduated
      ? '取消固化人格成长记忆？将关闭采集与召回、隐藏导航，已保存的数据保留。'
      : '固化上线人格成长记忆？将启用本角色、本会话中的人格成长，并显示独立管理页。不会改写角色卡，私聊默认不参与。')) return;
    button.disabled = true;
    try {
      await patchConfig({ enabled: !graduated, graduated: !graduated });
      redrawCard();
    } catch (error) {
      const status = $('#experiment-launch-result');
      if (status) status.textContent = `操作失败：${error.message}`;
    } finally { button.disabled = false; }
  });
}

async function loadPersonalityMemoryPage() {
  const box = $('#personality-memory-page');
  if (!box || state.personalityMemory.loading) return;
  state.personalityMemory.loading = true;
  try {
    const data = await api('/api/personality-memory/status');
    state.personalityMemory.data = data;
    const cfg = data.config || {};
    const entries = data.entries || [];
    const scopes = [...new Set(entries.map((row) => row.scope_key))];
    const selected = state.personalityMemory.scope;
    const visible = entries.filter((row) => !selected || row.scope_key === selected);
    box.innerHTML = `<div class="panel"><h2>人格成长记忆</h2>
      <p>核心性格来自角色卡；这里积累角色自己的偏好、共同经历与关系变化。不同角色卡和会话分别保存，私聊经历不带进群里。修改角色正文后会使用独立的成长记忆，旧数据仍可管理。</p>
      <p>新偏好和关系先作为「初步倾向」，跨日互动重复支持后才稳定；冲突内容保留为候选，不自动覆盖稳定记忆。管理员可以修正或确认。记录并不证明现实中见面或到场。</p>
      <div class="settings-actions">
        <label class="checkbox-row"><input type="checkbox" id="pm-enabled" ${cfg.enabled ? 'checked' : ''}>启用人格记忆</label>
        <label class="checkbox-row"><input type="checkbox" id="pm-auto" ${cfg.autoCapture ? 'checked' : ''}>自动积累</label>
        <label class="checkbox-row"><input type="checkbox" id="pm-private" ${cfg.allowPrivate ? 'checked' : ''}>允许私聊独立积累</label>
      </div>
      <label>每个角色每个会话最多条数 <input id="pm-max" type="number" min="12" max="500" value="${esc(cfg.maxEntriesPerScope)}"></label>
      <label>每轮记忆字符预算 <input id="pm-inject" type="number" min="300" max="6000" value="${esc(cfg.maxInjectChars || 2200)}"></label>
      <div class="settings-actions"><button type="button" class="btn btn-primary" id="pm-save">保存设置</button><button type="button" class="btn" id="pm-refresh">刷新</button></div>
      <p id="pm-status" role="status">${cfg.enabled ? '采集与召回按设置运行' : '已停用；数据保留，可继续查看和整理'}。共显示 ${entries.length} 条（最多 500 条）。</p>
      <label>来源会话 <select id="pm-scope"><option value="">全部会话</option>${scopes.map((scope) => `<option value="${esc(scope)}" ${scope === selected ? 'selected' : ''}>${esc(scope)}</option>`).join('')}</select></label>
      <div id="pm-entries">${visible.length ? visible.map((row) => `<article class="panel" data-pm-entry="${esc(row.id)}">
        <strong>${esc(labels[row.kind] || row.kind)} · ${row.status === 'active' ? '已稳定 / 已确认' : '初步倾向'}</strong>
        <p>${esc(row.persona_name)} · ${esc(row.persona_key)} · ${esc(row.scope_key)}${row.target_user_id ? ` · 对象 ${esc(row.target_user_id)}` : ''}</p>
        <p>${esc(row.topic)} · ${row.supportDays.length} 个证据日期</p>
        <textarea data-pm-content rows="3" maxlength="300" style="width:100%;box-sizing:border-box" aria-label="人格记忆内容">${esc(row.content)}</textarea>
        <details><summary>查看原始互动依据</summary>${row.evidence.map((item) => `<p>#${esc(item.id)} ${item.self ? '机器人' : esc(item.senderId)}：${esc(item.quote)}</p>`).join('')}</details>
        <div class="settings-actions"><button type="button" class="btn btn-small" data-pm-save>保存修正</button><button type="button" class="btn btn-small" data-pm-confirm>确认为稳定记忆</button><button type="button" class="btn btn-small btn-danger" data-pm-delete>删除</button></div>
      </article>`).join('') : '<p>暂无人格成长记忆。开启后，角色会在有具体互动依据时逐步积累，不会凭空生成经历。</p>'}</div>
    </div>`;
    $('#pm-refresh')?.addEventListener('click', () => loadPersonalityMemoryPage());
    $('#pm-scope')?.addEventListener('change', (event) => { state.personalityMemory.scope = event.target.value; void loadPersonalityMemoryPage(); });
    $('#pm-save')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await patchConfig({ enabled: $('#pm-enabled').checked, autoCapture: $('#pm-auto').checked,
          allowPrivate: $('#pm-private').checked, maxEntriesPerScope: Number($('#pm-max').value),
          maxInjectChars: Number($('#pm-inject').value) });
        await loadPersonalityMemoryPage();
      } catch (error) { $('#pm-status').textContent = `保存失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    box.querySelectorAll('[data-pm-entry]').forEach((article) => {
      article.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const id = article.dataset.pmEntry;
        const row = entries.find((item) => item.id === id);
        const remove = button.hasAttribute('data-pm-delete');
        const activate = button.hasAttribute('data-pm-confirm');
        button.disabled = true;
        try {
          if (!await askForConfirmation(remove ? '删除这条人格成长记忆？删除后不再参与回复。' : '保存这条人格记忆的修改？确认稳定后会作为后续交流的参考，但不会覆盖角色卡。')) return;
          await api(`/api/personality-memory/entries/${encodeURIComponent(id)}`, {
            method: remove ? 'DELETE' : 'POST', body: JSON.stringify(remove ? { confirm: true }
              : { confirm: true, content: article.querySelector('[data-pm-content]').value, status: activate ? 'active' : row.status })
          });
          await loadPersonalityMemoryPage();
        } catch (error) { $('#pm-status').textContent = `操作失败：${error.message}`; }
        finally { button.disabled = false; }
      });
    });
  } catch (error) {
    box.innerHTML = `<div class="panel"><p role="alert">人格记忆加载失败：${esc(error.message)}</p><button type="button" class="btn" id="pm-retry">重试</button></div>`;
    $('#pm-retry')?.addEventListener('click', () => loadPersonalityMemoryPage());
  } finally { state.personalityMemory.loading = false; }
}
export { renderPersonalityMemoryExperiment, bindPersonalityMemoryExperiment, loadPersonalityMemoryPage };
