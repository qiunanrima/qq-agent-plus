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

function renderLifeGraph(container, { nodes, edges }) {
  const graphNodes = new Map(nodes.map(node => [node.id, node]));
  const links = new Map();
  for (const edge of edges) {
    if (!graphNodes.has(edge.source) || !graphNodes.has(edge.target)) continue;
    for (const id of new Set([edge.source, edge.target])) {
      if (!links.has(id)) links.set(id, []);
      links.get(id).push(edge);
    }
  }
  if (!links.size) {
    container.textContent = '该会话暂无有效的长期记忆关联';
    return;
  }

  const label = id => graphNodes.get(id)?.label || id;
  const nameOf = edge => edge.type === 'mentions' ? '提到' : edge.type;
  const ordered = [...links.keys()].sort((a, b) => links.get(b).length - links.get(a).length);
  let focus = ordered.find(id => graphNodes.get(id).type === 'entity') || ordered[0];
  let page = 0;
  const pageSize = 8;
  container.innerHTML = `<div class="life-graph-controls">
    <label>中心节点 <select data-life-focus>${ordered.map(id => `<option value="${esc(id)}">${esc(label(id))}</option>`).join('')}</select></label>
    <button type="button" class="btn btn-small" data-life-prev>上一组</button>
    <button type="button" class="btn btn-small" data-life-next>下一组</button>
    <span data-life-count></span></div>
    <div class="life-graph-scroll"><div class="life-graph-diagram"></div></div>
    <div class="life-graph-detail" aria-live="polite"></div>`;
  const select = container.querySelector('[data-life-focus]');
  const previous = container.querySelector('[data-life-prev]');
  const next = container.querySelector('[data-life-next]');
  const diagram = container.querySelector('.life-graph-diagram');
  const detail = container.querySelector('.life-graph-detail');

  function showDetails(neighbor, relationships) {
    const alternateNames = graphNodes.get(neighbor)?.aliases || [];
    detail.innerHTML = `<h4>${esc(label(neighbor))}</h4>
      ${alternateNames.length ? `<p>同义名称 · ${esc(alternateNames.join('、'))}</p>` : ''}
      <ul>${relationships.map(edge => `<li>
        <strong>${esc(label(edge.source))}</strong> → ${esc(nameOf(edge))} → <strong>${esc(label(edge.target))}</strong>
        ${edge.memoryId ? `<div>来源 · ${esc(label('memory:' + edge.memoryId))}</div>` : ''}
        ${edge.evidence?.quote ? `<blockquote>${esc(edge.evidence.quote)}</blockquote>` : ''}
      </li>`).join('')}</ul>
      ${neighbor !== focus ? '<button type="button" class="btn btn-small" data-life-explore>以此节点为中心</button>' : ''}`;
    detail.querySelector('[data-life-explore]')?.addEventListener('click', () => setFocus(neighbor));
  }

  function draw() {
    const neighbors = new Map();
    for (const edge of links.get(focus)) {
      const neighbor = edge.source === focus ? edge.target : edge.source;
      if (!neighbors.has(neighbor)) neighbors.set(neighbor, []);
      neighbors.get(neighbor).push(edge);
    }
    const total = Math.ceil(neighbors.size / pageSize);
    const points = [...neighbors].slice(page * pageSize, (page + 1) * pageSize).map(([id, relationships], index, group) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / group.length;
      return { id, relationships, x: 50 + 35 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) };
    });
    select.value = focus;
    previous.disabled = page === 0;
    next.disabled = page + 1 >= total;
    container.querySelector('[data-life-count]').textContent = `${neighbors.size} 个相连节点${total > 1 ? ` · ${page + 1}/${total}` : ''}`;
    diagram.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      ${points.map(({x,y}) => `<line x1="50" y1="50" x2="${x}" y2="${y}" vector-effect="non-scaling-stroke"/>`).join('')}
      </svg><div class="life-graph-node life-graph-center" title="${esc(label(focus))}">${esc(label(focus))}</div>
      ${points.map(({id,x,y}, index) => `<button type="button" class="life-graph-node" data-life-neighbor="${index}"
        style="left:${x}%;top:${y}%" title="${esc(label(id))}" aria-pressed="false">${esc(label(id))}</button>`).join('')}`;
    detail.textContent = '点选相连节点查看关系和来源';
    const buttons = [...diagram.querySelectorAll('[data-life-neighbor]')];
    buttons.forEach((button, index) => button.addEventListener('click', () => {
      for (const node of buttons) node.setAttribute('aria-pressed', String(node === button));
      const { id, relationships } = points[index];
      showDetails(id, relationships);
    }));
  }

  function setFocus(id) {
    focus = id;
    page = 0;
    draw();
  }
  select.addEventListener('change', () => setFocus(select.value));
  previous.addEventListener('click', () => { page--; draw(); });
  next.addEventListener('click', () => { page++; draw(); });
  draw();
}

const lifeLoads = new WeakMap();

function normalizeLifeGraph({ nodes, edges }, aliases) {
  const normalize = value => {
    const key = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
    return key.replace(/^qq:?(\d+)$/, 'qq:$1');
  };
  const known = [
    ['银白长发', '银白色长发'], ['金色眼睛', '金瞳', '金色瞳孔', '金色双眸'],
    ['打雷', '雷声', '雷鸣']
  ];
  const labels = new Map();
  const redirects = new Map();
  const register = (alias, label) => {
    const key = normalize(alias), target = normalize(label);
    if (!key || !target) return;
    labels.set(target, label);
    if (key !== target) redirects.set(key, target);
    else redirects.delete(key);
  };
  for (const [label, ...variants] of known) for (const alias of variants) register(alias, label);
  for (const [alias, label] of aliases) register(alias, label);

  const canonical = value => {
    let key = normalize(value) || value;
    const visited = new Set();
    while (redirects.has(key) && !visited.has(key)) {
      visited.add(key);
      key = redirects.get(key);
    }
    return visited.has(key) ? [...visited].sort()[0] : key;
  };

  const remap = new Map();
  const merged = new Map();
  for (const node of nodes) {
    const entity = node.type === 'entity';
    const key = entity ? canonical(node.label) : '';
    const id = entity ? 'concept:' + key : node.id;
    remap.set(node.id, id);
    const label = labels.get(key) || node.label;
    if (!merged.has(id)) merged.set(id, { ...node, id, label, aliases: [] });
    const mergedNode = merged.get(id);
    if (node.label !== mergedNode.label && !mergedNode.aliases.includes(node.label)) mergedNode.aliases.push(node.label);
  }
  const dedup = new Map();
  for (const edge of edges) {
    const source = remap.get(edge.source), target = remap.get(edge.target);
    if (!source || !target || source === target) continue;
    const type = edge.type === '提及' ? 'mentions' : edge.type;
    const id = JSON.stringify([source, target, type, edge.memoryId || '', edge.evidence?.quote || '']);
    dedup.set(id, { ...edge, source, target, type });
  }
  return { nodes: [...merged.values()], edges: [...dedup.values()] };
}

function renderLiveProfiles(container, data) {
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(item => item.dataset.lifeDisclosure));
  const meter = (name, value) => `<div class="life-meter">
    <span>${esc(name)}</span><div class="life-meter-track" role="meter" aria-label="${esc(name)}" aria-valuemin="0"
      aria-valuemax="100" aria-valuenow="${Number(value)}"><span style="width:${Number(value)}%"></span></div>
    <b>${Number(value)}</b></div>`;
  container.innerHTML = data.profiles.map(profile => `<article class="life-profile">
    <h4>${esc(profile.name || profile.role)}</h4>
    <div class="life-emotion-grid">${Object.entries(profile.dimensions).map(([name, value]) => meter(name, value)).join('')}</div>
    ${profile.activity ? `<p>虚拟日常 · ${esc(profile.activity)}${Number.isFinite(profile.currentWillingness)
      ? ` · 当前聊天意愿 ${profile.currentWillingness}/100` : ''}</p>` : ''}
    <h5>内在动机</h5>
    ${profile.goals.map(goal => `<div>${meter(goal.title + ' · ' + goal.chat, goal.strength)}
      ${goal.reason ? `<p>${esc(goal.reason)} · 完成条件 ${esc(goal.condition)} · ${esc(new Date(goal.expires).toLocaleString())} 到期</p>` : ''}</div>`).join('') || '<p>暂无进行中的动机</p>'}
    <details class="life-interactions" data-life-disclosure="${esc(profile.role)}:events"${expanded.has(profile.role + ':events') ? ' open' : ''}>
      <summary>近期互动（${profile.events.length}）</summary>
      ${profile.events.map(event => `<div>${esc(new Date(event.at).toLocaleString())} · ${esc(event.kind)} · ${esc(event.chat)}</div>`).join('') || '<p>暂无互动记录</p>'}
    </details>
    ${profile.associations.length ? `<details data-life-disclosure="${esc(profile.role)}:associations"${expanded.has(profile.role + ':associations') ? ' open' : ''}>
      <summary>共同召回的记忆（${profile.associations.length}）</summary>
      ${profile.associations.map(row => `<div>${esc(row.chat)} · ${esc(row.actor)} → ${esc(row.memory)}（${Number(row.count)} 次）</div>`).join('')}
    </details>` : ''}
  </article>`).join('') || '<p>暂无角色数据</p>';
}

function renderLifeRhythm(container, { profiles, rhythm, willingness }) {
  const bars = (label, values, style = '') => `<div class="life-rhythm ${style}" aria-label="${label}">
    ${(values || []).map((value, hour) => `<div title="${hour}:00 · ${Number(value)}" style="height:${Number(value)}%"></div>`).join('')}</div>`;
  const profilesWithRhythm = profiles.filter(profile => profile.rhythm?.length);
  const series = profilesWithRhythm.length ? profilesWithRhythm : [{ rhythm, willingness }];
  container.innerHTML = series.map(profile => `
    ${series.length > 1 ? `<h4>${esc(profile.name || profile.role)}</h4>` : ''}
    ${profile.rhythmShift ? `<p>近期作息比设定${profile.rhythmShift > 0 ? '晚' : '早'} ${Math.abs(profile.rhythmShift)} 分钟</p>` : ''}
    <p>精力（0–100）</p>${bars('全天精力', profile.rhythm)}
    <p>聊天意愿（0–100）</p>${bars('全天聊天意愿', profile.willingness, 'life-rhythm-willingness')}
    <div class="life-axis"><span>00:00</span><span>12:00</span><span>23:00</span></div>`).join('');
}

async function loadCharacterLife() {
  const box = $('#character-life-page');
  if (!box) return;
  lifeLoads.get(box)?.abort();
  const controller = new AbortController();
  lifeLoads.set(box, controller);
  box.innerHTML = `<h2>角色生命系统</h2>
    <section class="life-section"><div class="life-section-heading">
      <h3>实时情绪</h3><small id="life-live-status">正在读取</small><button type="button" class="btn btn-small" id="life-refresh">刷新</button></div>
      <div id="life-live"></div></section>
    <section class="life-section"><h3>记忆关系图</h3>
      <label for="life-graph-scope">会话</label>
      <select id="life-graph-scope"><option value="">选择会话</option></select>
      <small id="life-scope-status"></small>
      <details id="life-alias-settings" hidden><summary>管理本会话的同义名称</summary>
        <label for="life-aliases">每行一组，例如「该角色 = 茉雪儿」。两边填同一个名称可取消自动归并。</label>
        <textarea id="life-aliases" rows="4"></textarea>
        <button type="button" class="btn btn-small" id="life-save-aliases">保存同义名称</button>
        <small id="life-alias-status" role="status"></small></details>
      <div id="life-graph" aria-live="polite"></div></section>
    <section class="life-section"><h3>24 小时节律</h3>
      <form id="life-schedule">
        <label>入睡时间 <input name="start" type="time" required></label>
        <label>起床时间 <input name="end" type="time" required></label>
        <label><input name="adaptive" type="checkbox"> 随近期互动微调</label>
        <button class="btn btn-small" type="submit">保存作息</button>
        <small id="life-schedule-status" role="status"></small>
      </form><div id="life-rhythm-data"></div></section>
    <section class="life-section"><h3>空闲整理</h3><div id="life-reflection"></div></section>`;
  const status = box.querySelector('#life-live-status');
  const select = box.querySelector('#life-graph-scope');
  const graph = box.querySelector('#life-graph');
  const aliasSettings = box.querySelector('#life-alias-settings');
  const aliases = box.querySelector('#life-aliases');
  const scheduleForm = box.querySelector('#life-schedule');
  let snapshot;
  let graphRequest = 0;
  let updating = false;
  let timer;
  const visible = () => !controller.signal.aborted && state.tab === 'character-life';
  controller.signal.addEventListener('abort', () => clearTimeout(timer));

  async function refresh() {
    if (!visible() || updating) return;
    updating = true;
    clearTimeout(timer);
    try {
      const data = await api('/api/character-life/status');
      if (!visible()) return;
      if (!snapshot && data.schedule) {
        scheduleForm.elements.start.value = data.schedule.sleepStart;
        scheduleForm.elements.end.value = data.schedule.sleepEnd;
        scheduleForm.elements.adaptive.checked = data.schedule.adaptive;
      }
      const graphScope = select.value;
      const learnedChanged = graphScope && JSON.stringify(snapshot?.learnedAliases?.[graphScope] || [])
        !== JSON.stringify(data.learnedAliases?.[graphScope] || []);
      snapshot = data;
      if (learnedChanged) void updateGraph(false);
      status.textContent = `${data.enabled ? '运行中' : '已停用'} · ${new Date(data.at || Date.now()).toLocaleTimeString()} 更新`;
      renderLiveProfiles(box.querySelector('#life-live'), data);
      renderLifeRhythm(box.querySelector('#life-rhythm-data'), data);
      const scopes = [...new Set(data.profiles.flatMap(profile =>
        [...profile.events, ...profile.associations].map(entry => entry.chat)).filter(chat => /^(group|private):\d+$/.test(chat)))];
      const current = select.value;
      if (current && !scopes.includes(current)) scopes.push(current);
      if (select.options.length !== scopes.length + 1 || scopes.some((scope, i) => select.options[i + 1]?.value !== scope)) {
        select.innerHTML = '<option value="">选择会话</option>' + scopes.map(scope => `<option value="${esc(scope)}">${esc(scope)}</option>`).join('');
        select.value = current;
      }
      box.querySelector('#life-scope-status').textContent = scopes.length ? '' : '暂无可查看的会话关系';
      const days = data.profiles.flatMap(profile => profile.reflections.map(row =>
        `<div>${esc(profile.name || profile.role)} · ${esc(row.date)} · ${esc(row.kind)} · ${Number(row.count)} 次</div>`));
      box.querySelector('#life-reflection').innerHTML = ((data.reflectionRuns || []).map(run =>
        `<p>${esc(run.chat)} · ${esc(new Date(run.at).toLocaleString())} · 累计合并 ${Number(run.merged)} 条 · 巩固 ${Number(run.reinforced)} 条 · 分析互动 ${Number(run.analyzed || 0)} 条</p>`).join('') || '<p>等待空闲整理</p>')
        + (days.length ? `<details><summary>按日汇总</summary>${days.join('')}</details>` : '');
    } catch (error) {
      if (visible()) status.textContent = '读取失败：' + error.message;
    } finally {
      updating = false;
      if (visible()) timer = setTimeout(refresh, 10000);
    }
  }

  async function updateGraph(resetAliases) {
    const scope = select.value;
    const request = ++graphRequest;
    const pairs = snapshot?.aliases?.[scope] || [];
    aliasSettings.hidden = !scope;
    if (resetAliases) {
      aliases.value = pairs.map(([from, to]) => `${from} = ${to}`).join('\n');
      box.querySelector('#life-alias-status').textContent = '';
    }
    graph.textContent = scope ? '载入关系…' : '';
    if (!scope) return;
    try {
      const data = await api(`/api/living-memory/graph?scopeKey=${encodeURIComponent(scope)}&limit=80`);
      if (visible() && request === graphRequest) {
        const learned = snapshot?.learnedAliases?.[scope] || [];
        renderLifeGraph(graph, normalizeLifeGraph(data, [...learned, ...pairs]));
      }
    } catch (error) {
      if (visible() && request === graphRequest) graph.textContent = '关系读取失败：' + error.message;
    }
  }

  select.addEventListener('change', () => void updateGraph(true));
  box.querySelector('#life-refresh').addEventListener('click', refresh);
  box.querySelector('#life-save-aliases').addEventListener('click', async event => {
    const button = event.currentTarget;
    const scope = select.value;
    const feedback = box.querySelector('#life-alias-status');
    const pairs = aliases.value.split('\n').filter(line => line.trim()).map(line => line.split(/[=＝]/).map(item => item.trim()));
    if (pairs.length > 75 || pairs.some(pair => pair.length !== 2 || pair.some(value => !value || value.length > 80))) {
      feedback.textContent = '每行填写一组别名和标准名，最多 75 组。';
      return;
    }
    button.disabled = true;
    try {
      await patchLifeConfig({ aliases: { [scope]: pairs } });
      if (!visible() || select.value !== scope) return;
      snapshot.aliases = { ...snapshot.aliases, [scope]: pairs };
      feedback.textContent = '已保存';
      await updateGraph(false);
    } catch (error) { feedback.textContent = '保存失败：' + error.message; }
    finally { button.disabled = false; }
  });
  scheduleForm.addEventListener('submit', async event => {
    event.preventDefault();
    const { start, end, adaptive } = scheduleForm.elements;
    const save = scheduleForm.querySelector('button');
    const feedback = box.querySelector('#life-schedule-status');
    if (start.value === end.value) { feedback.textContent = '入睡时间和起床时间需要不同。'; return; }
    save.disabled = true;
    try {
      await patchLifeConfig({ sleepStart: start.value, sleepEnd: end.value, adaptive: adaptive.checked });
      feedback.textContent = '已保存';
      await refresh();
    } catch (error) { feedback.textContent = '保存失败：' + error.message; }
    finally { save.disabled = false; }
  });
  await refresh();
}
export { renderLifeExperiment, bindLifeExperiment, loadCharacterLife };
