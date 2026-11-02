import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { fmtTime } from '../core/format.js';
import { state } from '../core/state.js';

async function loadHippocampusPage(offset = 0) {
  const box = $('#hippocampus-page');
  if (!box) return;
  const request = ++state.hippocampusRequest;
  box.innerHTML = '<div class="panel"><h2>海马记忆</h2><p>正在读取…</p></div>';
  try {
    const data = await api(`/api/memory/hippocampus?offset=${offset}`);
    if (request !== state.hippocampusRequest || !box.isConnected) return;
    box.innerHTML = `<div class="panel"><h2>海马记忆</h2>
      <p>今日与昨日的跨会话事件摘要。北京时间凌晨3点换日；长期卡片只注入索引。</p>
      <p>${data.enabled ? '已启用' : '已停用，数据保留'} · 记忆日 ${esc(data.day)} · ${data.active ? '正在消化' : '当前空闲'} · 待消化 ${esc(data.pendingDigestion)} 条</p>
      <p>摘要共 ${esc(data.episodeCount)} 条 · 长期卡片共 ${esc(data.cardCount)} 条 · 第 ${Math.floor(offset / 40) + 1} 页</p>
      <div class="settings-actions"><button type="button" class="btn" id="hip-refresh">刷新</button>
        <button type="button" class="btn" id="hip-prev" ${offset ? '' : 'disabled'}>上一页</button>
        <button type="button" class="btn" id="hip-next" ${offset + 40 < Math.max(data.episodeCount, data.cardCount) ? '' : 'disabled'}>下一页</button></div>
      <h3>周期摘要</h3>
      ${(data.episodes || []).map((r) => `<article class="panel" style="overflow-wrap:anywhere">
        <strong>${r.day === data.day ? '今日' : r.day === new Date(Date.parse(data.day) - 86400000).toISOString().slice(0, 10) ? '昨日' : '更早'} · ${esc(r.day)} · ${r.digested ? '已消化' : '未消化'} · ${r.closed ? '周期已结束' : '周期未关闭'}</strong>
        <p>${esc(r.chat)} · 角色 ${esc(r.persona)} · ${esc(fmtTime(r.updated))}</p>
        <p>${esc(r.summary)}</p>
        <details><summary>参与人物</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.participants)}</pre></details>
      </article>`).join('') || '<p>本页没有周期摘要。</p>'}
      <h3>长期卡片</h3><p>历史人格卡保留供管理员查看，已停止自动写入和供模型召回；人格成长统一在「人格成长」页管理。</p>
      ${(data.cards || []).map((r) => `<article class="panel" style="overflow-wrap:anywhere"><strong>${esc(r.kind)} · ${esc(r.title)}</strong>
        <p>对象 ${esc(r.subject)} · 角色 ${esc(r.persona)} · ${esc(fmtTime(r.updated))}</p><p>${esc(r.content)}</p><p>来源 ${esc(r.sources)}</p></article>`).join('') || '<p>本页没有长期卡片。</p>'}
      <p>全量清理使用「会话记忆」页的清除所有记忆与消息存档操作。</p></div>`;
    $('#hip-refresh')?.addEventListener('click', () => loadHippocampusPage(offset));
    $('#hip-prev')?.addEventListener('click', () => loadHippocampusPage(Math.max(0, offset - 40)));
    $('#hip-next')?.addEventListener('click', () => loadHippocampusPage(offset + 40));
  } catch (error) {
    if (request !== state.hippocampusRequest || !box.isConnected) return;
    box.innerHTML = `<div class="panel"><h2>海马记忆</h2><p role="alert">读取失败：${esc(error.message)}</p><button type="button" class="btn" id="hip-retry">重试</button></div>`;
    $('#hip-retry')?.addEventListener('click', () => loadHippocampusPage(offset));
  }
}

export { loadHippocampusPage };
