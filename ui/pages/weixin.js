import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { loadSettings } from '../app.js';

function renderWeixinExperiment(c = {}) {
  const cfg = c.weixin || {};
  return `<div class="experiment-card" data-independent-save><div class="experiment-card-main"><strong>微信官方渠道</strong>
    <p>${cfg.enabled ? '已启用' : '已停用'} · ${cfg.graduated ? '已固化' : '实验中'}。扫码、身份绑定与运行记录在独立页面。</p></div>
    <div class="experiment-card-side"><button class="btn btn-small" type="button" id="wx-open">打开微信渠道</button>
    <button class="btn btn-small" type="button" id="wx-toggle">${cfg.enabled ? '停用' : '启用'}</button>
    <button class="btn btn-small" type="button" id="wx-graduate">${cfg.graduated ? '取消固化' : '固化上线'}</button></div></div>`;
}
function renderWeixinSection(c = {}) {
  return `<section data-independent-save><h3>微信官方渠道 · iLink</h3>
    <p>与微信机器人私聊，复用角色卡与模型配置。首版支持文字回复、图片输入和已有语音转写；群聊、好友列表、微信历史记录与媒体发送尚未接入。</p>
    <p><button type="button" class="btn" id="wx-toggle">${c.weixin?.enabled ? '停用渠道' : '启用渠道'}</button>
    <button type="button" class="btn" id="wx-refresh">刷新状态</button></p>
    <div id="wx-status" role="status">正在读取状态…</div>
    <h3>扫码连接</h3><p>使用微信扫描官方授权二维码。扫码者默认允许私聊，但不会自动获得原生命令权限或绑定 QQ。</p>
    <p><button type="button" class="btn" id="wx-login">获取二维码</button>
    <button type="button" class="btn" id="wx-disconnect">解除账号连接</button></p>
    <div id="wx-qr" style="max-width:100%;overflow-wrap:anywhere"></div>
    <h3>身份与记忆</h3><p>只有确认属于同一个人后才填写 QQ 号并保存。绑定后双方共享该人物的长期印象，来源保留；聊天上下文、总结各自独立。解除绑定不删除已保存的长期记忆。</p>
    <p>原生命令权限单独开关，默认关闭；需要全局 CLI 原生审批也已开启，每次在控制台审批。身份绑定不会自动授予权限。</p>
    <div id="wx-peers" style="overflow-wrap:anywhere"></div>
    <h3>待核对发送</h3><p>仅在微信中确认实际结果后标记；这里的操作不会重发消息。</p><div id="wx-outbox"></div>
    <h3>运行记录</h3><div id="wx-runs"></div><p id="wx-result" role="status"></p></section>`;
}
async function refreshWeixin() {
  const node = $('#wx-status'); if (!node) return;
  const status = await api('/api/weixin/status');
  if ($('#wx-status') !== node) return;
  node.textContent = `${status.enabled ? '已启用' : '已停用'} · ${status.account ? '账号已连接' : '尚未扫码'} · ${status.running ? '正在收取消息' : '未运行'} · 未确认发送 ${status.unknownSends || 0} 条${status.error ? ` · ${status.error}` : ''}`;
  const peers = $('#wx-peers');
  peers.innerHTML = status.peers.length ? status.peers.map(peer => `<div class="card" data-wx-peer="${esc(peer.id)}">
    <p>微信用户：${esc(peer.userId)}</p><label><input type="checkbox" data-wx-enabled ${peer.enabled ? 'checked' : ''}>允许回复</label>
    <label><input type="checkbox" data-wx-native ${peer.nativeApproval ? 'checked' : ''}>允许请求原生命令（逐次审批）</label>
    <div class="field"><label>绑定的 QQ 号（留空解除共享）</label><input data-wx-qq inputmode="numeric" value="${esc(peer.qqId)}"></div>
    <p>本会话总结：${esc(peer.summary || '暂无')}</p><button type="button" class="btn" data-wx-save>确认保存</button></div>`).join('') : '<p>暂无联系人；扫码后向微信机器人发送一条消息。</p>';
  for (const button of peers.querySelectorAll('[data-wx-save]')) button.addEventListener('click', async () => {
    const card = button.closest('[data-wx-peer]');
    if (!await askForConfirmation('确认此微信用户的 QQ 身份、长期记忆共享和独立原生命令权限设置？')) return;
    button.disabled = true;
    try {
      await api(`/api/weixin/peers/${card.dataset.wxPeer}`, { method: 'POST', body: JSON.stringify({
        confirm: true, enabled: card.querySelector('[data-wx-enabled]').checked, nativeApproval: card.querySelector('[data-wx-native]').checked,
        qqId: card.querySelector('[data-wx-qq]').value.trim()
      }) });
      await refreshWeixin();
    } catch (error) { $('#wx-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#wx-runs').innerHTML = status.runs.slice().reverse().map(run => `<p>${esc(new Date(run.at).toLocaleString())} · ${esc(run.status)} · ${esc(String(run.seconds ?? '—'))} 秒${run.error ? ` · ${esc(run.error)}` : ''}</p>`).join('') || '<p>暂无运行记录。</p>';
  $('#wx-outbox').innerHTML = (status.unknownOutbox || []).map(item => `<p>${esc(new Date(item.at).toLocaleString())} · ${item.canResolve ? '结果未知' : '发送处理中'}
    ${item.canResolve ? `<button type="button" class="btn" data-wx-resolve="${esc(item.id)}" data-wx-sent="true">已核实发送成功</button>
    <button type="button" class="btn" data-wx-resolve="${esc(item.id)}" data-wx-sent="false">已核实未发送</button>` : ''}</p>`).join('') || '<p>暂无待核对发送。</p>';
  for (const button of $('#wx-outbox').querySelectorAll('[data-wx-resolve]')) button.addEventListener('click', async () => {
    if (!await askForConfirmation('已经在微信端核对这条发送的实际结果？只更新记录，不重发消息。')) return;
    button.disabled = true;
    try {
      await api(`/api/weixin/outbox/${button.dataset.wxResolve}`, { method: 'POST', body: JSON.stringify({ confirm: true, sent: button.dataset.wxSent === 'true' }) });
      await refreshWeixin();
    } catch (error) { $('#wx-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
function bindWeixinSettings() {
  const bind = (selector, action) => $(selector)?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await action(); } catch (error) { alert(`微信渠道：${error.message}`); }
    finally { button.disabled = false; }
  });
  const lifecycle = async patch => {
    await api('/api/weixin/lifecycle', { method: 'POST', body: JSON.stringify({ enabled: state.config?.weixin?.enabled === true, graduated: state.config?.weixin?.graduated === true, ...patch }) });
    await loadSettings();
  };
  bind('#wx-open', async () => { state.settingsSection = 'weixin'; await loadSettings(); });
  bind('#wx-toggle', async () => {
    const enabled = !state.config?.weixin?.enabled;
    if (enabled && !await askForConfirmation('启用微信官方渠道？已允许的联系人可触发模型调用与回复。')) return;
    await lifecycle({ enabled });
  });
  bind('#wx-graduate', async () => {
    if (await askForConfirmation('切换微信渠道独立入口的固化状态？不会改变启用状态。')) await lifecycle({ graduated: !state.config?.weixin?.graduated });
  });
  bind('#wx-refresh', refreshWeixin);
  bind('#wx-disconnect', async () => {
    if (!await askForConfirmation('解除微信账号连接并停止收发？聊天与记忆保留。')) return;
    await api('/api/weixin/disconnect', { method: 'POST', body: JSON.stringify({ confirm: true }) }); await refreshWeixin();
  });
  bind('#wx-login', async () => {
    const qr = await api('/api/weixin/login', { method: 'POST', body: '{}' });
    const panel = $('#wx-qr');
    panel.innerHTML = `<img alt="微信官方授权二维码" width="280" height="280" style="max-width:100%;height:auto" src="${esc(qr.qrcodeDataUrl)}">
      <p><input id="wx-code" inputmode="numeric" placeholder="仅在微信要求时填写验证码" aria-label="微信验证码"></p>
      <button type="button" class="btn" id="wx-poll">已扫码，检查状态</button><p id="wx-login-status" role="status"></p>`;
    bind('#wx-poll', async () => {
      $('#wx-login-status').textContent = '正在等待微信确认…';
      const result = await api(`/api/weixin/login/${qr.id}`, { method: 'POST', body: JSON.stringify({ verifyCode: $('#wx-code').value.trim() }) });
      if ($('#wx-qr') !== panel) return;
      const labels = { confirmed: '连接成功', wait: '等待扫码，请稍后再次检查', scaned: '已扫码，请在手机上确认', expired: '二维码已过期，请重新获取', need_verifycode: '请填写手机显示的验证码后再次检查', verify_code_blocked: '验证码已被限制，请重新获取二维码', scaned_but_redirect: '已切换官方登录节点，请再次检查' };
      $('#wx-login-status').textContent = labels[result.status] || result.status;
      if (result.status === 'confirmed') { panel.innerHTML = '<p>已连接。启用渠道后可接收私聊消息。</p>'; await refreshWeixin(); }
    });
  });
  if ($('#wx-status')) void refreshWeixin().catch(() => { const node = $('#wx-status'); if (node) node.textContent = '微信状态读取失败'; });
}
export { renderWeixinExperiment, renderWeixinSection, bindWeixinSettings };
