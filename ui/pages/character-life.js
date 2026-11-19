import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation, syncGraduatedFeatureNavigation } from '../core/dom-util.js';
import { switchTab } from '../app.js';

function renderLifeExperiment(c) {
  const config = c.characterLife || {};
  return `<div class="experiment-card" id="experiment-character-life">
    <div class="experiment-card-main"><strong>角色生命系统</strong>
      <p>观察真实互动产生的情绪、动机与每日节律。</p>
      <small>${config.enabled ? '已启用' : '已停用'} · ${config.graduated ? '已固化' : '实验中'}</small></div>
    <div class="experiment-card-side"><label class="checkbox-row"><input type="checkbox" id="life-experiment-enabled" ${config.enabled ? 'checked' : ''}>启用</label>
      <button type="button" class="btn btn-small" id="life-open">查看生命状态</button>
      <button type="button" class="btn btn-small" id="life-graduate">${config.graduated ? '取消固化' : '固化上线'}</button></div>
  </div>`;
}

async function patchLifeConfig(patch) {
  const response = await api('/api/config', { method: 'POST', body: JSON.stringify({ characterLife: patch }) });
  state.config = response.config || state.config;
  syncGraduatedFeatureNavigation(state.config);
}

function bindLifeExperiment() {
  const redrawCard = () => {
    const card = $('#experiment-character-life');
    if (card) card.outerHTML = renderLifeExperiment(state.config || {});
    bindLifeExperiment();
  };
  // 生命周期开关即时保存，不让设置页把它误判为未保存的草稿；其他控件照常追踪。
  $('#life-experiment-enabled')?.addEventListener('input', (event) => event.stopPropagation());
  $('#life-experiment-enabled')?.addEventListener('change', async (event) => {
    event.stopPropagation();
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try { await patchLifeConfig({ enabled: toggle.checked }); redrawCard(); }
    catch (error) {
      toggle.checked = !toggle.checked;
      const status = $('#experiment-launch-result');
      if (status) status.textContent = `保存失败：${error.message}`;
    } finally { toggle.disabled = false; }
  });
  $('#life-open')?.addEventListener('click', () => switchTab('character-life'));
  $('#life-graduate')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const graduated = state.config?.characterLife?.graduated === true;
    if (!await askForConfirmation(graduated
      ? '取消固化角色生命系统？将停用生命系统、隐藏导航，已保存的数据保留。'
      : '固化上线角色生命系统？将启用生命状态并显示独立导航入口。')) return;
    button.disabled = true;
    try {
      await patchLifeConfig({ enabled: !graduated, graduated: !graduated });
      redrawCard();
    } catch (error) {
      const status = $('#experiment-launch-result');
      if (status) status.textContent = `操作失败：${error.message}`;
    } finally { button.disabled = false; }
  });
}

async function loadCharacterLife() {
  const box = $('#character-life-page');
  if (!box) return;
  try {
    const data = await api('/api/character-life/status');
    const bar = (name, value) => `<div class="life-meter"><span>${esc(name)}</span><meter min="0" max="100" value="${Number(value)}"></meter><b>${Number(value)}</b></div>`;
    const scopes = [...new Set(data.profiles.flatMap(profile =>
      [...profile.events, ...profile.associations].map(entry => entry.chat)).filter(Boolean))];
    box.innerHTML = `<h2>角色生命系统</h2><p>${data.enabled ? '运行中' : '已停用'} <button class="btn btn-small" id="life-refresh">刷新</button></p>
      ${data.profiles.length ? '' : '<p>暂无互动记录。启用后，角色参与的 QQ 对话会显示在这里。</p>'}
      ${data.profiles.map(p => `<article><h3>${esc(p.role)}</h3><h4>当前情绪</h4>${Object.entries(p.dimensions).map(([k,v])=>bar(k,v)).join('')}
        <h4>内在动机</h4>${p.goals.map(g=>bar(g.title+' · '+g.chat,g.strength)).join('') || '暂无待续邀约'}
        <h4>近期互动</h4>${p.events.map(e=>`<div>${esc(new Date(e.at).toLocaleString())} · ${esc(e.kind)} · ${esc(e.chat)}</div>`).join('')}
        <h4>空闲整理</h4>${p.reflections.map(r=>`<div>${esc(r.date)} · ${esc(r.kind)} · ${Number(r.count)} 次</div>`).join('') || '尚无整理记录'}
        <h4>共同召回的记忆</h4>${p.associations.map(a=>`<div>${esc(a.chat)} · ${esc(a.actor)} → ${esc(a.memory)}（${Number(a.count)} 次）</div>`).join('') || '暂无关联'}</article>`).join('')}
      <h3>记忆关系图</h3>
      ${scopes.length ? `<label for="life-graph-scope">会话</label>
        <select id="life-graph-scope"><option value="">选择会话</option>${scopes.map(scope => `<option value="${esc(scope)}">${esc(scope)}</option>`).join('')}</select>
        <div id="life-graph" aria-live="polite"></div>` : '<p>暂无可查看的会话关系</p>'}
      <h3>记忆巩固</h3>
      ${(data.reflectionRuns || []).map(run => `<p>${esc(run.chat)} · 最近整理 ${esc(new Date(run.at).toLocaleString())} · 累计合并 ${Number(run.merged)} 条 · 巩固 ${Number(run.reinforced)} 条</p>`).join('') || '<p>等待空闲整理</p>'}
      <h3>24 小时节律基线</h3><p>按当前睡眠时段推算的精力（0–100）</p><div class="life-rhythm" aria-label="全天精力参考值">${data.rhythm.map((v,h)=>`<div title="${h}:00 · ${v}" style="height:${Number(v)}%"></div>`).join('')}</div><div class="life-axis"><span>00:00</span><span>12:00</span><span>23:00</span></div>`;
    $('#life-graph-scope')?.addEventListener('change', async event => {
      const select = event.currentTarget;
      const scope = select.value;
      const graph = $('#life-graph');
      graph.textContent = scope ? '载入关系…' : '';
      if (!scope) return;
      try {
        const { nodes, edges } = await api(`/api/living-memory/graph?scopeKey=${encodeURIComponent(scope)}&limit=80`);
        if (scope !== select.value) return;
        const labels = new Map(nodes.map(node => [node.id, node.label]));
        graph.innerHTML = edges.length
          ? `<ul class="life-graph-edges">${edges.map(edge => `<li><b>${esc(labels.get(edge.source) || '')}</b>
            <span>${esc(edge.type === 'mentions' ? '提到' : edge.type)}</span>
            <b>${esc(labels.get(edge.target) || '')}</b>
            ${edge.memoryId ? `<small>来源 · ${esc(labels.get('memory:' + edge.memoryId) || edge.memoryId)}${edge.evidence?.quote ? ` · 「${esc(edge.evidence.quote)}」` : ''}</small>` : ''}</li>`).join('')}</ul>`
          : '<p>该会话暂无有效的长期记忆关联</p>';
      } catch (error) {
        if (scope === select.value) graph.textContent = '关系读取失败：' + error.message;
      }
    });
    $('#life-refresh')?.addEventListener('click',loadCharacterLife);
  } catch (error) { box.textContent = '生命状态读取失败：'+error.message; }
}
export { renderLifeExperiment, bindLifeExperiment, loadCharacterLife };
