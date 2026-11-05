import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { loadSettings, refreshStatus, renderSettings } from '../app.js';

function renderAntigravitySection(c = {}) {
  const a = c.antigravityCli || {};
  const field = (key, label, value, type = 'text', extra = '') => `<div class="field"><label for="agy-${key}">${label}</label><input id="agy-${key}" type="${type}" value="${esc(String(value))}" ${extra}></div>`;
  return `<h3>Antigravity CLI</h3>
    <p>接管普通文字聊天；角色卡、记忆、工具权限和 QQ 发送由 QQ Agent 管理。辅助请求及专用模型覆盖仍走原 API。</p>
    <p class="hint">辅助 API 模型：${esc(c.api?.model || '未设置')}。启用 CLI 后仍需保留 API 配置。</p>
    <div class="hint" id="agy-runtime-status">正在读取本机状态…</div>
    <p><button type="button" class="btn" id="agy-toggle">${a.enabled ? '停用 CLI，切回 API' : '启用 CLI 聊天'}</button>
    <button type="button" class="btn" id="agy-refresh">刷新状态</button></p>
    <h3>调用设置</h3>
    ${field('executable', 'CLI 可执行文件路径', a.executable || 'agy')}
    ${field('workspace', '独立工作目录（绝对路径）', a.workspace || '')}
    <div class="hint">先以服务用户创建目录并完成 CLI 登录。不要使用源码、数据或凭据目录。</div>
    ${field('agent', '自定义 Agent 名称', a.agent || 'qq-mcp')}
    ${field('model', 'CLI 模型 ID（留空使用 CLI 默认模型）', a.model || '')}
    <div class="field"><label for="agy-transport">工具传输</label><select id="agy-transport">${['mcp', 'json'].map(v => `<option value="${v}" ${a.transport === v || (!a.transport && v === 'mcp') ? 'selected' : ''}>${v === 'mcp' ? 'MCP（推荐）' : 'JSON（兼容）'}</option>`).join('')}</select></div>
    <div class="field"><label for="agy-effort">思考档位</label><select id="agy-effort">${['low', 'medium', 'high'].map(v => `<option value="${v}" ${(a.effort || 'low') === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    ${field('timeoutMs', 'CLI 超时（毫秒，最多 60 秒）', Math.min(a.timeoutMs ?? 60000, 60000), 'number', 'min="1000" max="60000" step="1000"')}
    ${field('maxConcurrent', '全局并发上限（每个私聊或群聊最多 1 个 CLI）', a.maxConcurrent ?? 1, 'number', 'min="1" max="4"')}
    ${field('maxToolCalls', '单次工具调用上限', a.maxToolCalls ?? 16, 'number', 'min="1" max="128"')}
    <p class="hint">状态刷新与保存设置不调用 Google。失败不自动重试；并发限制不等于每小时调用限额。CLI 提前收尾时可能无法取得 Token 用量。</p>
    <div class="save-bar"><button type="button" class="btn btn-primary" id="agy-save">保存 CLI 设置</button><span id="cfg-dirty-note" class="muted"></span><span id="agy-save-result" role="status"></span></div>`;
}

function renderAntigravityExperiment(c = {}) {
  const a = c.antigravityCli || {};
  return `<div class="experiment-card" data-independent-save>
    <div class="experiment-card-main"><strong>Antigravity CLI</strong><p>${a.enabled ? '已启用' : '已停用'} · ${a.graduated ? '已固化' : '实验中'}。路径、模型与调用限制在独立设置页维护。</p></div>
    <div class="experiment-card-side"><button type="button" class="btn btn-small" id="agy-open">打开 CLI 设置</button>
    <button type="button" class="btn btn-small" id="agy-experiment-toggle">${a.enabled ? '停用' : '启用'}</button>
    <button type="button" class="btn btn-small" id="agy-graduate">${a.graduated ? '取消固化' : '固化上线'}</button></div></div>`;
}

async function saveAntigravityPatch(patch) {
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ antigravityCli: patch }) });
  state.config = r.config || await api('/api/config');
  await refreshStatus();
}

async function loadAntigravityStatus() {
  const node = $('#agy-runtime-status');
  if (!node) return;
  try {
    const s = await api('/api/antigravity-cli/status');
    if ($('#agy-runtime-status') !== node) return;
    node.textContent = `${s.enabled ? 'CLI 已启用' : 'CLI 已停用，聊天使用 API'} · 正在运行 ${s.active || 0} 个调用 · ${s.valid ? (s.workspaceReady ? '工作目录就绪' : '工作目录尚未就绪') : '配置无效'}。本机状态不代表账号认证或模型调用已验证。`;
  } catch { if ($('#agy-runtime-status') === node) node.textContent = '状态读取失败，请确认后端已更新。'; }
}

function bindAntigravitySettings() {
  const bind = (id, action) => {
    const button = $(id);
    if (!button) return;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); }
      catch (e) { alert(`Antigravity：${e.message}`); }
      finally { button.disabled = false; }
    });
  };
  const toggle = async () => {
    const enabled = state.config?.antigravityCli?.enabled !== true;
    if (enabled && !await askForConfirmation('启用 CLI 接管普通文字聊天？请先保存路径设置，并确认已用服务用户登录。')) return;
    await saveAntigravityPatch({ enabled });
    renderSettings();
  };
  bind('#agy-toggle', toggle);
  bind('#agy-experiment-toggle', toggle);
  bind('#agy-refresh', loadAntigravityStatus);
  bind('#agy-open', async () => { state.settingsSection = 'antigravity-cli'; await loadSettings(); });
  bind('#agy-graduate', async () => {
    const graduated = state.config?.antigravityCli?.graduated !== true;
    if (!await askForConfirmation(graduated ? '固化 CLI 设置入口？这不会自动启用 CLI。' : '取消固化？现有配置和启用状态保留。')) return;
    await saveAntigravityPatch({ graduated });
    renderSettings();
  });
  bind('#agy-save', async () => {
    const patch = {};
    for (const key of ['executable', 'workspace', 'agent', 'model', 'transport', 'effort']) patch[key] = $(`#agy-${key}`).value.trim();
    for (const key of ['timeoutMs', 'maxConcurrent', 'maxToolCalls']) {
      const input = $(`#agy-${key}`);
      if (!input.checkValidity() || !input.value.trim()) throw new Error('请填写有效的调用限制');
      patch[key] = Number(input.value);
    }
    await saveAntigravityPatch(patch);
    state.settingsDirty = false;
    const dirty = $('#cfg-dirty-note');
    if (dirty) dirty.textContent = '';
    const result = $('#agy-save-result');
    if (result) result.textContent = '已保存，不改变启用状态';
    await loadAntigravityStatus();
  });
  void loadAntigravityStatus();
}

export { bindAntigravitySettings, loadAntigravityStatus, renderAntigravityExperiment, renderAntigravitySection };
