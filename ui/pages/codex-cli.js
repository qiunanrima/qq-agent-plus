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
  <p class="hint">额度查询与请求队列位于总览，与 AGY 放在一起。</p>
  ${field('executable', 'ACP 可执行文件（Windows 建议填 node.exe 绝对路径）', 'codex-acp')}
  ${field('adapterScript', '适配器 JS 绝对路径（直接运行 codex-acp 时留空）')}
  ${field('workspace', '独立工作目录（绝对路径）')}${field('model', '模型 ID（留空沿用 CLI 默认）')}
  <div class="field"><label for="codex-model-catalog">从 CLI 模型列表选择</label><select id="codex-model-catalog"><option value="">沿用 CLI 默认</option>${cfg.model ? `<option value="${esc(cfg.model)}" selected>${esc(cfg.model)}（当前配置）</option>` : ''}</select></div>
  <button class="btn" id="codex-models-refresh">获取模型列表</button><p class="hint" id="codex-models-result" role="status">先保存路径并登录，再获取列表。查询不发送聊天；选择后需保存设置。</p>
  <div class="field"><label for="codex-effort">思考档位</label><select id="codex-effort">${['low', 'medium', 'high'].map(v => `<option ${v === (cfg.effort || 'low') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
  ${field('timeoutMs', '执行超时毫秒（1000–60000，不含排队时间）', 60000, 'number')}${field('maxConcurrent', '全局并发（1–4，每个会话最多一个）', 1, 'number')}${field('maxToolCalls', '工具调用上限（1–128）', 16, 'number')}
  <p class="hint">并发满后按先来先服务排队，最多等待32个请求、每个最多等60秒。取消或停用会撤销等待请求，不会启动 CLI。</p>
  <p class="hint">未开启模型回退时，启用前请停用 Antigravity CLI。保存和刷新状态不调用模型；失败不重试，用量无法取得时标为未知。</p>
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
    if ($('#codex-status') === node) node.textContent = `${result.enabled ? '已启用' : '已停用'} · ACP · 正在运行 ${result.active} 个调用 · 排队 ${result.queued} 个 · ${result.valid && result.workspaceReady ? '目录就绪' : '请检查配置和目录'}。本机状态不代表登录或模型调用已验证。`;
  } catch { if ($('#codex-status') === node) node.textContent = '状态读取失败'; }
}
function renderCodexQuota(data) {
  data ||= {};
  if (!data.checkedAt) return '尚未查询';
  const windows = (data.windows || []).map(window => `<p>${esc(window.name)}：剩余 <strong>${esc(String(window.remainingPercent))}%</strong> ${esc(window.reset || '')}</p>`).join('');
  const credits = data.unlimited ? '<p>Credits：不限额</p>' : data.credits != null ? `<p>Credits：${esc(String(data.credits))}</p>` : '';
  return `${data.plan ? `<p>ChatGPT ${esc(data.plan)}</p>` : ''}${windows}${credits}${!data.available ? '<p>账号未返回额度，当前额度未知。</p>' : ''}<p class="hint">查询时间：${esc(new Date(data.checkedAt).toLocaleString())}${data.cached ? ' · 缓存' : ''}${data.stale ? ' · 结果已过期，请刷新' : ''}。重置时间按服务器时区显示。</p>`;
}
function renderCodexQuotaCard(data, status) {
  const queue = status ? `正在运行 ${Number(status.active) || 0} 个调用 · 排队 ${Number(status.queued) || 0} 个` : '队列状态暂不可用';
  return `<section class="panel" id="codex-quota-card" style="margin-bottom:20px"><div class="panel-head"><div class="panel-titles"><h3>Codex 剩余额度与请求队列</h3><div class="panel-sub" id="codex-queue-status">${esc(queue)}</div></div><div class="panel-actions"><button class="btn" id="codex-quota-refresh">查询 / 刷新额度</button></div></div><div class="panel-body"><p class="hint">手动查询账号限额，不生成模型回复；一分钟内复用结果。额度未知时不会显示成零。最多排队32个请求，等待不超过60秒。</p><div id="codex-quota-result" role="status">${renderCodexQuota(data)}</div></div></section>`;
}
function bindCodexQuotaCard() {
  $('#codex-quota-refresh')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await loadCodexQuota(true); } finally { button.disabled = false; }
  });
}
async function loadCodexQuota(refresh = false) {
  const node = $('#codex-quota-result'); if (!node) return;
  if (refresh) node.textContent = '正在查询账号额度…';
  try {
    const result = await api('/api/codex-cli/quota', { method: refresh ? 'POST' : 'GET' });
    if ($('#codex-quota-result') === node) node.innerHTML = renderCodexQuota(result);
  } catch (error) { if ($('#codex-quota-result') === node) node.textContent = error.message; }
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
  $('#codex-model-catalog')?.addEventListener('change', () => {
    $('#codex-model').value = $('#codex-model-catalog').value;
    state.settingsDirty = true;
    $('#codex-models-result').textContent = '模型已选择，请保存 Codex 设置。';
  });
  bind('#codex-models-refresh', async () => {
    const select = $('#codex-model-catalog'), note = $('#codex-models-result');
    note.textContent = '正在从已保存的 CLI 配置获取模型列表…';
    try {
      const result = await api('/api/codex-cli/models', { method: 'POST' });
      if ($('#codex-model-catalog') !== select) return;
      const current = $('#codex-model').value.trim();
      const models = result.models || [];
      select.innerHTML = '<option value="">沿用 CLI 默认</option>' +
        (current && !models.some(model => model.id === current) ? `<option value="${esc(current)}">${esc(current)}（当前配置，列表未返回）</option>` : '') +
        models.map(model => `<option value="${esc(model.id)}">${esc(model.name)} · ${esc(model.id)}</option>`).join('');
      select.value = current;
      note.textContent = `已获取 ${models.length} 个模型。CLI 当前模型：${result.currentModel || '未知'}。选择后请保存。`;
    } catch (error) {
      if ($('#codex-models-result') === note) note.textContent = error.message;
    }
  });
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

export { renderCodexSection, renderCodexExperiment, bindCodexSettings, renderCodexQuotaCard, bindCodexQuotaCard };
