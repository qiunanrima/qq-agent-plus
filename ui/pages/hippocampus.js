import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { chatNameOf, formatChatTitle, fmtTime } from '../core/format.js';
import { state } from '../core/state.js';

const kinds = { person: '人物印象', skill: '学到的方法', personality: '历史人格' };
function arrayOf(value) {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function scopeName(key) { return formatChatTitle(String(key || ''), chatNameOf(key)); }
function metadata(rows) {
  return `<details class="hip-meta"><summary>查看详细来源</summary><dl>${rows.map(([label, value]) =>
    `<div><dt>${esc(label)}</dt><dd>${esc(value || '—')}</dd></div>`).join('')}</dl></details>`;
}
function episodeHtml(row, day) {
  const yesterday = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  const label = row.day === day ? '今日' : row.day === yesterday ? '昨日' : '更早';
  const people = arrayOf(row.participants).map((person) => person?.name || person?.id).filter(Boolean);
  return `<article class="hip-entry" data-hip-entry>
    <div class="hip-entry-head"><strong>${label} · ${esc(row.day)}</strong><span class="hip-state ${row.digested ? '' : 'is-pending'}">${row.digested ? '已消化' : '待消化'}</span></div>
    <p class="hip-content">${esc(row.summary)}</p>
    <div class="hip-entry-meta"><span>${esc(scopeName(row.chat))}</span><time>${esc(fmtTime(row.updated))}</time><span>${row.closed ? '周期已结束' : '周期进行中'}</span>${people.length ? `<span>${esc(people.join('、'))}</span>` : ''}</div>
    ${metadata([['角色标识', row.persona], ['来源会话', row.chat], ['参与人物', people.join('、')]])}
  </article>`;
}
function cardHtml(row) {
  return `<article class="hip-entry" data-hip-card>
    <div class="hip-entry-head"><h3>${esc(row.title)}</h3><span class="hip-state">${esc(kinds[row.kind] || row.kind)}</span></div>
    <p class="hip-content">${esc(row.content)}</p>
    <div class="hip-entry-meta"><span>${row.subject === 'self' ? '角色自己' : `对象 ${esc(row.subject)}`}</span><time>${esc(fmtTime(row.updated))}</time></div>
    ${metadata([['角色标识', row.persona], ['来源会话', arrayOf(row.sources).map(scopeName).join('、')]])}
  </article>`;
}
function renderHippocampusHtml(data, tab, offset) {
  const episodes = data.episodes || [], cards = data.cards || [];
  const total = Number(tab === 'episodes' ? data.episodeCount : data.cardCount) || 0;
  const count = tab === 'episodes' ? episodes.length : cards.length;
  return `<header class="pane-head hip-head"><div><h2>海马记忆</h2><p class="pane-sub">记住今日与昨日的片段，沉淀长期印象。北京时间凌晨 3 点换日。</p></div>
    <div class="hip-head-actions"><span class="lm-state ${data.enabled ? 'ok' : 'idle'}"><i></i>${data.enabled ? '已启用' : '已停用 · 数据保留'}</span><button type="button" class="btn btn-small" id="hip-refresh">刷新</button></div></header>
    <div class="kpi-grid hip-stats">
      <div class="kpi"><div class="kpi-label">周期摘要</div><div class="kpi-value">${esc(data.episodeCount)}</div><div class="kpi-sub">今日与昨日</div></div>
      <div class="kpi"><div class="kpi-label">长期卡片</div><div class="kpi-value">${esc(data.cardCount)}</div><div class="kpi-sub">印象与方法</div></div>
      <div class="kpi"><div class="kpi-label">待消化</div><div class="kpi-value">${esc(data.pendingDigestion)}</div><div class="kpi-sub">${data.active ? '正在消化' : '当前空闲'}</div></div>
    </div>
    <div class="plugin-tabs hip-tabs" role="tablist" aria-label="海马记忆分类">
      <button type="button" class="plugin-tab ${tab === 'episodes' ? 'is-on' : ''}" id="hip-episodes-tab" role="tab" aria-selected="${tab === 'episodes'}" aria-controls="hip-episodes" data-hip-tab="episodes">周期摘要<span class="plugin-tab-n">${esc(data.episodeCount)}</span></button>
      <button type="button" class="plugin-tab ${tab === 'cards' ? 'is-on' : ''}" id="hip-cards-tab" role="tab" aria-selected="${tab === 'cards'}" aria-controls="hip-cards" data-hip-tab="cards">长期卡片<span class="plugin-tab-n">${esc(data.cardCount)}</span></button>
    </div>
    <div class="hip-toolbar"><span>第 ${Math.floor(offset / 40) + 1} 页 · ${total ? `${offset + 1}–${offset + count} / ${total} 条` : '暂无记录'} · 记忆日 ${esc(data.day)}</span>
      <div class="hip-pagination"><button type="button" class="btn btn-small" id="hip-prev" ${offset ? '' : 'disabled'}>上一页</button><button type="button" class="btn btn-small" id="hip-next" ${offset + 40 < total ? '' : 'disabled'}>下一页</button></div></div>
    <section class="hip-panel" id="hip-episodes" role="tabpanel" aria-labelledby="hip-episodes-tab" ${tab === 'episodes' ? '' : 'hidden'}>
      ${episodes.length ? episodes.map((row) => episodeHtml(row, data.day)).join('') : '<div class="hip-empty">本页没有周期摘要。完成新的聊天后，这里会记录事件片段。</div>'}</section>
    <section class="hip-panel" id="hip-cards" role="tabpanel" aria-labelledby="hip-cards-tab" ${tab === 'cards' ? '' : 'hidden'}>
      <p class="hip-note">从聊天片段中消化出的长期印象和方法。历史人格卡仅供查看，新的人格成长在「人格成长」页管理。</p>
      ${cards.length ? cards.map(cardHtml).join('') : '<div class="hip-empty">本页没有长期卡片。记忆日结束后，有价值的片段会在消化完成后沉淀到这里。</div>'}</section>
    <footer class="hip-bottom"><span>这里只查看记录，清理请前往「会话记忆」。</span><button type="button" class="btn btn-small" id="hip-top">回到顶部</button></footer>`;
}

async function loadHippocampusPage(offset = null) {
  const box = $('#hippocampus-page'), scroller = $('#view-hippocampus');
  if (!box || !scroller) return;
  const tab = state.hippocampus.tab;
  const target = offset ?? state.hippocampus.offsets[tab];
  const request = ++state.hippocampusRequest;
  const samePage = box.dataset.tab === tab && Number(box.dataset.offset) === target;
  const scrollTop = scroller.scrollTop;
  if (!box.childElementCount) box.innerHTML = '<header class="pane-head"><h2>海马记忆</h2></header><p class="hip-empty" role="status">正在读取记忆…</p>';
  box.setAttribute('aria-busy', 'true');
  $('#hip-refresh')?.setAttribute('disabled', '');
  try {
    const data = await api(`/api/memory/hippocampus?offset=${target}`);
    if (request !== state.hippocampusRequest || !box.isConnected) return;
    state.hippocampus.offsets[tab] = target;
    box.innerHTML = renderHippocampusHtml(data, tab, target);
    box.dataset.tab = tab; box.dataset.offset = String(target);
    scroller.scrollTop = samePage ? scrollTop : 0;
    $('#hip-refresh')?.addEventListener('click', () => loadHippocampusPage(target));
    $('#hip-prev')?.addEventListener('click', () => loadHippocampusPage(Math.max(0, target - 40)));
    $('#hip-next')?.addEventListener('click', () => loadHippocampusPage(target + 40));
    $('#hip-top')?.addEventListener('click', () => { scroller.scrollTop = 0; });
    box.querySelectorAll('[data-hip-tab]').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.hipTab === state.hippocampus.tab) return;
      state.hippocampus.tab = button.dataset.hipTab;
      void loadHippocampusPage();
    }));
  } catch (error) {
    if (request !== state.hippocampusRequest || !box.isConnected) return;
    delete box.dataset.tab; delete box.dataset.offset;
    box.innerHTML = `<header class="pane-head"><h2>海马记忆</h2></header><div class="hip-empty"><p role="alert">读取失败：${esc(error.message)}</p><button type="button" class="btn" id="hip-retry">重试</button></div>`;
    $('#hip-retry')?.addEventListener('click', () => loadHippocampusPage(target));
  } finally {
    if (request === state.hippocampusRequest) box.setAttribute('aria-busy', 'false');
  }
}

export { loadHippocampusPage };
