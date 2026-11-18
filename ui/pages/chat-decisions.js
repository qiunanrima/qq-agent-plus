import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { fmtTime } from '../core/format.js';

const decisionOutcomes = {
  skipped: '未触发', blocked: '预算拦截', replied: '已回复', noreply: '已处理，未回复',
  aborted: '已中止', error: '运行失败'
};

function renderDecision(decision) {
  const outcome = decisionOutcomes[decision.outcome] || '未知状态';
  const parts = [fmtTime(decision.at), decision.reason === outcome ? '' : decision.reason, decision.note];
  if (decision.outcome === 'skipped') parts.push(`随机概率 ${Number(decision.percent) || 0}%`);
  if (decision.messageCount > 0) parts.push(`本批 ${decision.messageCount} 条消息`);
  if (decision.sentCount > 0) parts.push(`已发送 ${decision.sentCount} 条`);
  return `<li><strong>${esc(outcome)}</strong> · ${esc(parts.filter(Boolean).join(' · '))}</li>`;
}

function renderDecisionHistory(chatKey) {
  if (!chatKey) return '';
  return `<details class="collapsible chat-decisions" data-chat-decisions="${esc(chatKey)}">
    <summary>最近决策记录</summary>
    <div class="coll-body" data-decision-results>正在加载…</div>
  </details>`;
}

async function refreshChatDecisions(panel) {
  if (!panel?.open || panel.dataset.loading) return;
  const body = panel.querySelector('[data-decision-results]');
  if (!body) return;
  panel.dataset.loading = 'true';
  try {
    const key = encodeURIComponent(panel.dataset.chatDecisions.replace(':', '_'));
    const { decisions } = await api(`/api/chats/${key}/decisions`);
    const html = decisions.length ? `<ol>${decisions.map(renderDecision).join('')}</ol>` : '暂无决策记录';
    if (body.innerHTML !== html) body.innerHTML = html;
  } catch {
    body.textContent = '决策记录加载失败，稍后刷新或重新展开重试。';
  } finally {
    delete panel.dataset.loading;
  }
}

function bindDecisionHistory(container, previous) {
  const panel = container.querySelector('[data-chat-decisions]');
  if (!panel?.dataset.chatDecisions) return;
  if (previous && previous.dataset.chatDecisions === panel.dataset.chatDecisions) {
    panel.replaceWith(previous);
    void refreshChatDecisions(previous);
    return;
  }
  panel.addEventListener('toggle', () => void refreshChatDecisions(panel));
}

function refreshDecisionHistory(container) {
  void refreshChatDecisions(container?.querySelector('[data-chat-decisions]'));
}

export { bindDecisionHistory, refreshDecisionHistory, renderDecisionHistory };
