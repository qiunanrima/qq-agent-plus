import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { askForConfirmation } from '../core/dom-util.js';
import { renderSettings } from '../app.js';

function renderCodexSection(c = {}) {
  const cfg = c.codexCli || {};
  const field = (key, label, fallback = '', type = 'text') => `<div class="field"><label for="codex-${key}">${label}</label><input id="codex-${key}" type="${type}" value="${esc(String(cfg[key] ?? fallback))}"></div>`;
  return `<h3>Codex CLI · ACP</h3><p>接管普通文字聊天，角色卡、记忆、工具及消息发送由宿主管理。辅助请求仍使用 API。原生命令、文件和浏览器工具暂不开放。</p>
  <p class="hint">安装 @agentclientprotocol/codex-acp@2.6.0，以服务用户在独立工作目录下创建 codex-home，设置 CODEX_HOME 指向该目录后运行 codex login。专属目录不能放 config.toml 或 AGENTS.md。不要使用源码或数据目录。</p>
  <p id="codex-status" role="status">正在读取本机状态…</p><button class="btn" id="codex-toggle">${cfg.enabled ? '停用 Codex' : '启用 Codex'}</button> <button class="btn" id="codex-refresh">刷新状态</button>
  ${field('executable', 'ACP 可执行文件（Windows 建议填 node.exe 绝对路径）', 'codex-acp')}
  ${field('adapterScript', '适配器 JS 绝对路径（直接运行 codex-acp 时留空）')}
  ${field('workspace', '独立工作目录（绝对路径）')}${field('model', '模型 ID（留空沿用 CLI 默认）')}
  <div class="field"><label for="codex-effort">思考档位</label><select id="codex-effort">${['low', 'medium', 'high'].map(v => `<option ${v === (cfg.effort || 'low') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
  ${field('timeoutMs', '超时毫秒（1000–60000）', 60000, 'number')}${field('maxConcurrent', '全局并发（1–4，每个会话最多一个）', 1, 'number')}${field('maxToolCalls', '工具调用上限（1–128）', 16, 'number')}
  <p class="hint">启用前请停用 Antigravity CLI。保存和刷新状态不调用模型；失败不重试，用量无法取得时标为未知。</p>
  <div class="save-bar"><button class="btn btn-primary" id="codex-save">保存 Codex 设置</button><span id="cfg-dirty-note" class="muted"></span><span id="codex-result" role="status"></span></div>`;
}
function renderCodexExperiment(c = {}) {
  const cfg = c.codexCli || {};
  return `<div class="experiment-card" data-independent-save><div class="experiment-card-main"><strong>Codex CLI</strong><p>${cfg.enabled ? '已启用' : '已停用'} · ${cfg.graduated ? '已固化' : '实验中'}</p></div><div class="experiment-card-side"><button class="btn btn-small" id="codex-open">打开 Codex 设置</button><button class="btn btn-small" id="codex-experiment-toggle">${cfg.enabled ? '停用' : '启用'}</button><button class="btn btn-small" id="codex-graduate">${cfg.graduated ? '取消固化' : '固化上线'}</button></div></div>`;
}
async function saveCodex(patch) {
  const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ codexCli: patch }) });
  state.config = result.config || await api('/api/config');
}
async function loadCodexStatus() {
  const node = $('#codex-status'); if (!node) return;
  try {
    const result = await api('/api/codex-cli/status');
    if ($('#codex-status') === node) node.textContent = `${result.enabled ? '已启用' : '已停用'} · ACP · 正在运行 ${result.active} 个调用 · ${result.valid && result.workspaceReady ? '目录就绪' : '请检查配置和目录'}。本机状态不代表登录或模型调用已验证。`;
  } catch { if ($('#codex-status') === node) node.textContent = '状态读取失败'; }
}
function bindCodexSettings() {
  const bind = (id, action) => $(id)?.addEventListener('click', async () => {
    const button = $(id); button.disabled = true;
    try { await action(); } catch (error) { alert(`Codex：${error.message}`); } finally { button.disabled = false; }
  });
  const toggle = async () => {
    const enabled = !state.config?.codexCli?.enabled;
    if (enabled && !await askForConfirmation('启用 Codex ACP 接管文字聊天？请先保存路径并完成专属目录登录。')) return;
    await saveCodex({ enabled }); renderSettings();
  };
  bind('#codex-toggle', toggle); bind('#codex-experiment-toggle', toggle);
  bind('#codex-open', () => { state.settingsSection = 'codex-cli'; renderSettings(); });
  bind('#codex-refresh', loadCodexStatus);
  bind('#codex-graduate', async () => {
    const graduated = !state.config?.codexCli?.graduated;
    if (!await askForConfirmation(graduated ? '固化 Codex CLI，使设置入口常驻？运行开关保持独立。' : '取消固化 Codex CLI？配置继续保留。')) return;
    await saveCodex({ graduated }); renderSettings();
  });
  bind('#codex-save', async () => {
    const patch = {};
    for (const key of ['executable', 'adapterScript', 'workspace', 'model', 'effort']) patch[key] = $('#codex-' + key).value.trim();
    for (const key of ['timeoutMs', 'maxConcurrent', 'maxToolCalls']) patch[key] = Number($('#codex-' + key).value);
    await saveCodex(patch); state.settingsDirty = false;
    const dirty = $('#cfg-dirty-note'); if (dirty) dirty.textContent = '';
    $('#codex-result').textContent = '已保存'; await loadCodexStatus();
  });
  void loadCodexStatus();
}

export { renderCodexSection, renderCodexExperiment, bindCodexSettings };
