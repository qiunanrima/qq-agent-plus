import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { loadSettings } from '../app.js';

function renderAgentWechatExperiment(c = {}) {
  const w = c.agentWechat || {};
  return `<div class="experiment-card" data-independent-save id="experiment-agent-wechat"><div class="experiment-card-main"><strong>微信接入 · Agent WeChat</strong>
    <p>${w.enabled ? '已启用' : '已停用'} · ${w.graduated ? '已固化' : '实验中'}。复用现有 Agent；连接、独立白名单与身份绑定在微信页面。</p></div>
    <div class="experiment-card-side"><button type="button" class="btn btn-small" id="wechat-open">打开微信接入</button>
    <button type="button" class="btn btn-small" id="wechat-toggle">${w.enabled ? '停用' : '启用'}</button>
    <button type="button" class="btn btn-small" id="wechat-graduate">${w.graduated ? '取消固化' : '固化上线'}</button></div></div>`;
}
function renderAgentWechatSection(c = {}) {
  const w = c.agentWechat || {};
  return `<section data-independent-save id="wechat-page"><h3>微信接入 · Agent WeChat</h3>
    <p>微信负责收发，消息进入现有 Agent、角色卡和模型。当前支持私聊文字，群聊暂未开放。</p>
    <p><button type="button" class="btn" id="wechat-toggle">${w.enabled ? '停用微信' : '启用微信'}</button>
    <button type="button" class="btn" id="wechat-refresh">刷新状态</button></p><p id="wechat-status" role="status">正在读取状态…</p>
    <h3>本地协议服务</h3><div class="field"><label for="wechat-endpoint">服务地址（仅本机）</label><input id="wechat-endpoint" value="${esc(w.endpoint || 'http://127.0.0.1:6174')}"></div>
    <div class="field"><label for="wechat-account">服务中的账号 ID</label><input id="wechat-account" value="${esc(w.accountId || '')}"></div>
    <div class="field"><label for="wechat-token-file">服务器上的令牌文件路径</label><input id="wechat-token-file" value="${esc(w.tokenFile || '')}"></div>
    <h3>微信私聊白名单</h3><p>每行一个 wxid；空白表示全部禁止。QQ 白名单独立生效。未绑定 QQ 的联系人仍按 wxid 独立处理。</p>
    <div class="field"><label for="wechat-allow">允许的 wxid</label><textarea id="wechat-allow" rows="5">${esc((w.allow || []).join('\n'))}</textarea></div>
    <h3>身份绑定 · wxid → QQ</h3><p>每行填写「wxid QQ号」。绑定后关联该 QQ 的人物记忆，微信上下文与消息存档单独保存。绑定不授予管理权限，也不会自动加入白名单。</p>
    <div class="field"><label for="wechat-bindings">身份对应关系</label><textarea id="wechat-bindings" rows="5">${esc(Object.entries(w.bindings || {}).map(([id, qq]) => `${id} ${qq}`).join('\n'))}</textarea></div>
    <p>QQ 管理员私聊也可操作：<code>绑定微信 wxid QQ号</code>、<code>解绑微信 wxid</code>、<code>微信白名单 添加 wxid</code>、<code>微信白名单 移除 wxid</code>。发送 <code>微信绑定</code> 查看配置。</p>
    <p><button type="button" class="btn" id="wechat-save">确认保存微信设置</button></p><p id="wechat-result" role="status"></p>
    <p>停用保留绑定与数据。发送结果未知时会停止当前会话；可在异常处理和会话详情核对。</p></section>`;
}
async function refreshAgentWechat() {
  const node = $('#wechat-status'); if (!node) return;
  const s = await api('/api/agent-wechat/status');
  if ($('#wechat-status') !== node) return;
  node.textContent = `${s.enabled ? '已启用' : '已停用'} · ${s.running ? '接入运行中' : '接入未运行'} · ${s.online ? '微信已连接' : '尚未确认微信连接'}${s.error ? ` · ${s.error}` : ''}`;
}
function bindAgentWechatSettings() {
  const bind = (id, fn) => $(id)?.addEventListener('click', async event => {
    const b = event.currentTarget; b.disabled = true;
    try { await fn(); } catch (e) { const node = $('#wechat-result'); if (node) node.textContent = e.message; else alert(e.message); }
    finally { b.disabled = false; }
  });
  const save = async config => {
    await api('/api/agent-wechat/config', { method: 'POST', body: JSON.stringify({ confirm: true, config }) });
    await loadSettings();
  };
  bind('#wechat-open', async () => { state.settingsSection = 'agent-wechat'; await loadSettings(); });
  bind('#wechat-refresh', refreshAgentWechat);
  bind('#wechat-toggle', async () => {
    const enabled = !state.config?.agentWechat?.enabled;
    if (enabled && !await askForConfirmation('启用微信接入？仅微信白名单中的私聊可触发现有 Agent 回复。')) return;
    await save({ enabled });
  });
  bind('#wechat-graduate', async () => {
    if (await askForConfirmation('切换微信接入入口的固化状态？启用状态单独保留。')) await save({ graduated: !state.config?.agentWechat?.graduated });
  });
  bind('#wechat-save', async () => {
    const bindings = {};
    for (const line of $('#wechat-bindings').value.split('\n').map(s => s.trim()).filter(Boolean)) {
      const pair = line.split(/\s+/); if (pair.length !== 2) throw new Error('绑定每行需填写 wxid 和 QQ 号');
      if (Object.hasOwn(bindings, pair[0])) throw new Error('同一 wxid 只能绑定一个 QQ 号');
      bindings[pair[0]] = pair[1];
    }
    if (!await askForConfirmation('保存微信连接、独立白名单和身份绑定？请确认 wxid 与 QQ 属于同一个人。')) return;
    await save({ endpoint: $('#wechat-endpoint').value.trim(), accountId: $('#wechat-account').value.trim(), tokenFile: $('#wechat-token-file').value.trim(),
      allow: $('#wechat-allow').value.split(/\s+/).filter(Boolean), bindings });
  });
  if ($('#wechat-status')) void refreshAgentWechat().catch(() => { const n = $('#wechat-status'); if (n) n.textContent = '微信状态读取失败'; });
}
export { renderAgentWechatExperiment, renderAgentWechatSection, bindAgentWechatSettings };
