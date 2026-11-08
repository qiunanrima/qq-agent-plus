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
    <p>微信负责收发，消息进入现有 Agent、角色卡和模型。私聊和群聊使用独立白名单；支持文字、图片和协议可下载的表情包。</p>
    <p><button type="button" class="btn" id="wechat-toggle">${w.enabled ? '停用微信' : '启用微信'}</button>
    <button type="button" class="btn" id="wechat-refresh">刷新状态</button></p><p id="wechat-status" role="status">正在读取状态…</p>
    <h3>本地协议服务</h3><div class="field"><label for="wechat-endpoint">服务地址（仅本机）</label><input id="wechat-endpoint" value="${esc(w.endpoint || 'http://127.0.0.1:6174')}"></div>
    <div class="field"><label for="wechat-account">服务中的账号 ID</label><input id="wechat-account" value="${esc(w.accountId || '')}"></div>
    <div class="field"><label for="wechat-token-file">服务器上的令牌文件路径</label><input id="wechat-token-file" value="${esc(w.tokenFile || '')}"></div>
    <h3>微信私聊白名单</h3><p>每行一个 wxid；空白表示全部禁止。QQ 白名单独立生效。未绑定 QQ 的联系人仍按 wxid 独立处理。</p>
    <p><button type="button" class="btn" id="wechat-pick-contacts">从微信联系人选择</button></p>
    <div class="field"><label for="wechat-allow">允许的 wxid</label><textarea id="wechat-allow" rows="5">${esc((w.allow || []).join('\n'))}</textarea></div>
    <h3>微信群白名单</h3><p>每行一个群 ID（数字@chatroom）；空白禁止全部群聊。只启用明确勾选的群。</p>
    <p><button type="button" class="btn" id="wechat-pick-groups">从微信群选择</button></p>
    <div class="field"><label for="wechat-groups">允许的群 ID</label><textarea id="wechat-groups" rows="4">${esc((w.groups || []).join('\n'))}</textarea></div>
    <p><label><input type="checkbox" id="wechat-native-approval" ${w.nativeApproval ? 'checked' : ''}>允许微信请求原生文件、前台命令工具（管理员每次审批）</label></p>
    <h3>身份绑定 · wxid → QQ</h3><p>每行填写「wxid QQ号」。绑定后关联该 QQ 的人物记忆，微信上下文与消息存档单独保存。绑定不授予管理权限，也不会自动加入白名单。</p>
    <div class="field"><label for="wechat-bindings">身份对应关系</label><textarea id="wechat-bindings" rows="5">${esc(Object.entries(w.bindings || {}).map(([id, qq]) => `${id} ${qq}`).join('\n'))}</textarea></div>
    <p><label><input type="checkbox" id="wechat-share-private-memory" ${w.sharePrivateMemoryInGroups ? 'checked' : ''}>QQ 群及微信群可读取绑定成员另一平台的私聊来源记忆</label></p>
    <p>开启后由 Agent 根据场合决定是否提及。绑定后的私聊支持双向查摘要及人物记忆，不读取完整聊天记录；绑定关系会告知两边的 Agent。</p>
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
async function openWechatContactPicker(kind = 'contacts') {
  const input = $(kind === 'groups' ? '#wechat-groups' : '#wechat-allow'); if (!input) return;
  const selected = new Set(input.value.split(/\s+/).filter(Boolean));
  const contacts = new Map();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:calc(100vw - 32px)" role="dialog" aria-modal="true" aria-label="选择微信联系人">
    <div class="modal-head">选择微信联系人</div>
    <input id="wechat-contact-search" aria-label="搜索微信联系人" placeholder="搜索昵称、备注、微信号或 wxid">
    <p id="wechat-contact-count" role="status"></p><div class="modal-list" id="wechat-contact-list"></div>
    <p id="wechat-contact-status" role="status"></p><div class="modal-foot" style="flex-wrap:wrap">
    <button type="button" class="btn" id="wechat-contact-more">读取联系人</button>
    <button type="button" class="btn btn-primary" id="wechat-contact-apply">确定选择</button>
    <button type="button" class="btn" id="wechat-contact-cancel">取消</button></div></div>`;
  document.body.appendChild(overlay);
  const find = selector => overlay.querySelector(selector);
  if (kind === 'groups') {
    find('[role="dialog"]').setAttribute('aria-label', '选择微信群');
    find('.modal-head').textContent = '选择微信群';
    find('#wechat-contact-search').placeholder = '搜索群名称或群 ID';
  }
  let cursor = '', loaded = false, busy = false, partial = false;
  const close = () => { overlay.remove(); $('#wechat-pick-contacts')?.focus(); };
  const render = () => {
    const query = find('#wechat-contact-search').value.trim().toLowerCase();
    const rows = new Map(contacts);
    for (const wxid of selected) if (!rows.has(wxid)) rows.set(wxid, { wxid, name: '已选联系人（尚未同步资料）' });
    const visible = [...rows.values()].filter(row => Object.values(row).join(' ').toLowerCase().includes(query));
    find('#wechat-contact-count').textContent = `已选 ${selected.size} 人 · 已读取 ${contacts.size} 位联系人`;
    find('#wechat-contact-list').innerHTML = visible.map(row => `<label class="pick-item" style="align-items:flex-start">
      <input type="checkbox" value="${esc(row.wxid)}" ${selected.has(row.wxid) ? 'checked' : ''}>
      <span style="min-width:0;overflow-wrap:anywhere"><strong>${esc(row.name)}</strong>
      <br><span class="muted">${esc(row.wxid)}${row.alias ? ` · 微信号：${esc(row.alias)}` : ''}</span></span></label>`).join('')
      || '<p class="muted">没有匹配的联系人；可加载更多，或保留手动填写的 wxid。</p>';
    find('#wechat-contact-list').querySelectorAll('input').forEach(box => box.addEventListener('change', () => {
      if (box.checked) selected.add(box.value); else selected.delete(box.value);
      find('#wechat-contact-count').textContent = `已选 ${selected.size} 人 · 已读取 ${contacts.size} 位联系人`;
    }));
  };
  const load = async () => {
    if (busy) return;
    busy = true; const button = find('#wechat-contact-more'); button.disabled = true;
    find('#wechat-contact-status').textContent = '正在读取微信联系人…';
    try {
      const data = await api(`/api/agent-wechat/contacts?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!overlay.isConnected) return;
      for (const row of data.items || []) contacts.set(row.wxid, row);
      loaded = true; partial ||= data.partial; cursor = data.nextCursor || '';
      render(); button.hidden = !cursor; button.textContent = '加载更多联系人';
      find('#wechat-contact-status').textContent = `${partial ? '协议端资料尚未完整同步。' : ''}确定后还需保存微信设置才会生效。`;
    } catch (error) {
      if (overlay.isConnected) { find('#wechat-contact-status').textContent = error.message; button.textContent = loaded ? '重试加载更多' : '重试读取'; }
    } finally { busy = false; button.disabled = false; }
  };
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  find('#wechat-contact-search').addEventListener('input', render);
  find('#wechat-contact-more').addEventListener('click', load);
  find('#wechat-contact-cancel').addEventListener('click', close);
  find('#wechat-contact-apply').addEventListener('click', () => {
    if ($(kind === 'groups' ? '#wechat-groups' : '#wechat-allow') === input) {
      input.value = [...selected].join('\n');
      $('#wechat-result').textContent = `已选择 ${selected.size} 位联系人，请保存微信设置后生效。`;
    }
    close();
  });
  render(); find('#wechat-contact-search').focus(); await load();
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
  bind('#wechat-pick-contacts', () => openWechatContactPicker());
  bind('#wechat-pick-groups', () => openWechatContactPicker('groups'));
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
      allow: $('#wechat-allow').value.split(/\s+/).filter(Boolean), groups: $('#wechat-groups').value.split(/\s+/).filter(Boolean),
      nativeApproval: $('#wechat-native-approval').checked, sharePrivateMemoryInGroups: $('#wechat-share-private-memory').checked, bindings });
  });
  if ($('#wechat-status')) void refreshAgentWechat().catch(() => { const n = $('#wechat-status'); if (n) n.textContent = '微信状态读取失败'; });
}
export { renderAgentWechatExperiment, renderAgentWechatSection, bindAgentWechatSettings };
