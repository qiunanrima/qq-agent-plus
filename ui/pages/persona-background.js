import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { state } from '../core/state.js';
import { QARegistry } from '../core/registry.js';

function renderPersonaBackground(c) {
  const keys = Object.keys(c.personaPerChat || {});
  return `<section id="persona-background" class="panel" data-independent-save>
    <h3>角色背景知识 · Markdown</h3>
    <p class="hint">填写 AI 正在扮演角色的身世、往事、人物关系与世界观。只注入章节索引，相关话题由模型主动查阅正文。与聊天记忆分开，清除记忆不会删除此文档。</p>
    <div class="field"><label for="background-role">背景所属角色（以已保存的人设为准）</label>
      <select id="background-role"><option value="">全局角色</option>${keys.map((key) => `<option value="${esc(key)}">会话 ${esc(key)}</option>`).join('')}</select></div>
    <p class="hint" id="background-status" role="status">正在加载…</p>
    <div class="field"><label for="background-file">导入一份 Markdown（先载入草稿，再单独保存）</label>
      <input id="background-file" type="file" accept=".md,text/markdown"></div>
    <div class="field"><label for="background-content">角色背景正文</label>
      <textarea id="background-content" rows="12" style="width:100%;min-height:240px" placeholder="你正在编写的角色背景 Markdown，可在完成后导入。推荐使用 # / ## 划分章节。" disabled></textarea></div>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button class="btn" id="background-save" type="button" disabled>单独保存背景</button>
      <button class="btn" id="background-reload" type="button">重新加载</button>
      <button class="btn" id="background-clear" type="button" disabled>清除该角色背景</button>
    </div><p class="hint">最多512 KiB。相同角色跨会话共用；更换角色卡会切换对应文档。覆盖与清除前自动备份旧文档。自定义卡修改正文后视为新角色，请先保存人设再导入背景。</p>
    <details><summary>模型可见的章节索引</summary><pre id="background-index" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>
  </section>`;
}

async function bindPersonaBackground() {
  const box = document.getElementById('persona-background');
  if (!box || box.dataset.bound) return;
  box.dataset.bound = 'true';
  const find = (id) => box.querySelector(`#background-${id}`);
  const editor = find('content'), status = find('status'), role = find('role');
  let doc = null, busy = false;
  const url = () => `/api/persona-background?chatKey=${encodeURIComponent(role.value)}`;
  const draftKey = () => doc?.roleKey;
  const dirty = () => doc && editor.value !== doc.content;
  const remember = () => {
    if (doc) state.personaBackgroundDrafts[draftKey()] = { value: editor.value, revision: doc.revision };
  };
  const show = (data) => {
    doc = data;
    const draft = state.personaBackgroundDrafts[draftKey()];
    editor.value = draft?.revision === doc.revision ? draft.value : doc.content;
    editor.disabled = false;
    find('save').disabled = false;
    find('clear').disabled = !doc.content;
    find('index').textContent = doc.sections.map((s) => `${s.id}  ${s.title}`).join('\n') || '尚无背景文档';
    status.textContent = `${doc.roleName} · ${doc.sections.length} 段 · ${doc.bytes} 字节${dirty() ? ' · 有未保存的草稿' : ''}`;
  };
  const load = async () => {
    if (busy) return;
    busy = true;
    editor.disabled = true;
    find('save').disabled = true;
    find('clear').disabled = true;
    role.disabled = true;
    try { const data = await api(url()); if (box.isConnected) show(data); }
    catch (error) { status.textContent = `加载失败：${error.message}`; doc = null; }
    finally { busy = false; role.disabled = false; }
  };
  editor.addEventListener('input', () => { remember(); status.textContent = '背景草稿未保存，请点「单独保存背景」'; });
  role.addEventListener('change', () => { remember(); load(); });
  find('reload').addEventListener('click', async () => {
    if (busy || (dirty() && !await askForConfirmation('丢弃当前背景草稿，重新读取已保存的文档？'))) return;
    if (doc) delete state.personaBackgroundDrafts[draftKey()];
    await load();
  });
  find('file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || !doc || busy) return;
    if (!/\.md$/i.test(file.name) || file.size > 512 * 1024) { status.textContent = '请选择不超过512 KiB的 .md 文档'; return; }
    if (dirty() && !await askForConfirmation('用导入文件替换当前未保存的背景草稿？')) return;
    const target = doc;
    const text = await file.text();
    if (!box.isConnected || doc !== target || busy) return;
    editor.value = text; remember();
    status.textContent = `已导入 ${file.name}，尚未保存`;
  });
  for (const action of ['save', 'clear']) find(action).addEventListener('click', async () => {
    if (!doc || busy) return;
    if (action === 'clear' && !await askForConfirmation('清除当前角色的背景文档？旧文档会备份，聊天记忆不受影响。')) return;
    busy = true;
    editor.disabled = role.disabled = true;
    find('save').disabled = find('clear').disabled = true;
    try {
      const data = await api(url(), { method: action === 'clear' ? 'DELETE' : 'POST',
        body: JSON.stringify({ content: editor.value, roleKey: doc.roleKey, revision: doc.revision, confirm: action === 'clear' }) });
      delete state.personaBackgroundDrafts[draftKey()];
      if (box.isConnected) { show(data); status.textContent += action === 'clear' ? ' · 已清除' : ' · 已保存，下次唤醒生效'; }
    } catch (error) { status.textContent = `操作失败：${error.message}（草稿保留；角色或文档冲突时请重新加载）`; }
    finally {
      busy = false; editor.disabled = role.disabled = false;
      find('save').disabled = false; find('clear').disabled = !doc?.content;
    }
  });
  await load();
}

QARegistry.onAfter('renderSettings', () => { void bindPersonaBackground(); });
export { renderPersonaBackground, bindPersonaBackground };
