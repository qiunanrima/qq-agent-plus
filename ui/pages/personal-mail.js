import { api } from '../core/api.js';
import { $ } from '../core/dom.js';

const fields = {
  gmail: [
    ['clientId', 'OAuth 客户端 ID', 'text'],
    ['clientSecret', 'OAuth 客户端密钥', 'password'],
    ['refreshToken', '刷新令牌', 'password']
  ],
  qq: [
    ['user', 'QQ 邮箱地址', 'email'],
    ['authCode', 'IMAP 客户端授权码', 'password']
  ]
};

function updateMailForm(form, provider) {
  form.elements.enabled.checked = provider.enabled;
  form.querySelector('[data-mail-state]').textContent = !provider.configured ? '待配置'
    : provider.enabled ? '已启用' : '已停用';
  for (const [name] of fields[form.dataset.mailProvider]) {
    form.elements[name].value = '';
    form.elements[name].placeholder = provider.present[name] ? '已配置，留空保留' : '';
  }
  form.querySelector('[data-mail-test]').disabled = !provider.configured;
}

function mailForm(provider, title, setup) {
  return `<form class="panel" data-mail-provider="${provider}" autocomplete="off">
    <h3>${title}</h3>
    <p data-mail-state aria-live="polite"></p>
    <p>${setup}</p>
    ${fields[provider].map(([name, label, type]) => `<div class="field">
      <label for="mail-${name}">${label}</label>
      <input id="mail-${name}" name="${name}" type="${type}" maxlength="4096"
        autocomplete="${type === 'password' ? 'new-password' : 'off'}" spellcheck="false">
    </div>`).join('')}
    <p><label><input type="checkbox" name="enabled"> 允许 Agent 查阅</label></p>
    <p><button type="submit" class="btn">保存</button>
    <button type="button" class="btn" data-mail-test>测试连接</button></p>
    <p data-mail-result role="status"></p>
  </form>`;
}

function bindMailForm(form, status) {
  updateMailForm(form, status);
  const endpoint = '/api/personal-mail/' + form.dataset.mailProvider;
  const test = form.querySelector('[data-mail-test]');
  const save = form.querySelector('button[type="submit"]');
  const result = form.querySelector('[data-mail-result]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(fields[form.dataset.mailProvider].map(([name]) => [name, form.elements[name].value]));
    const body = JSON.stringify({ enabled: form.elements.enabled.checked, values });
    save.disabled = true;
    test.disabled = true;
    result.textContent = '正在保存…';
    try {
      const response = await api(endpoint, { method: 'POST', body });
      status = response.provider;
      updateMailForm(form, status);
      result.textContent = '已保存。';
    } catch (error) {
      result.textContent = error.message;
    } finally {
      save.disabled = false;
      test.disabled = !status.configured;
    }
  });

  test.addEventListener('click', async () => {
    save.disabled = true;
    test.disabled = true;
    result.textContent = '正在测试已保存的配置…';
    try {
      const { status: connection } = await api(endpoint + '/test', { method: 'POST' });
      result.textContent = connection === 'ok' ? '连接成功。' : connection === 'not_configured'
        ? '请先保存授权字段。' : '连接失败，请核对授权和服务器网络。';
    } catch (error) {
      result.textContent = error.message;
    } finally {
      save.disabled = false;
      test.disabled = !status.configured;
    }
  });
}

async function loadPersonalMailPage() {
  const page = $('#personal-mail-page');
  if (!page) return;
  page.innerHTML = '<h2>个人邮箱</h2><p role="status">正在读取邮箱设置…</p>';
  const loading = page.lastElementChild;
  try {
    const { providers } = await api('/api/personal-mail');
    if (page.lastElementChild !== loading) return;
    page.innerHTML = `<h2>个人邮箱</h2>
      <p>授权后，管理员 QQ 私聊可以结合邮件、手机日历和容器资料做会前准备。</p>
      ${mailForm('gmail', 'Gmail', '使用已开启 Gmail API 的 OAuth 客户端，授权范围选 gmail.readonly。 <a href="https://developers.google.com/identity/protocols/oauth2/web-server#offline" target="_blank" rel="noopener">查看 Google 授权说明</a>')}
      ${mailForm('qq', 'QQ 邮箱', '在 QQ 邮箱开启 IMAP，生成第三方客户端授权码。 <a href="https://service.mail.qq.com/" target="_blank" rel="noopener">打开 QQ 邮箱帮助</a>')}`;
    page.querySelectorAll('[data-mail-provider]').forEach((form) => bindMailForm(form, providers[form.dataset.mailProvider]));
  } catch (error) {
    if (page.lastElementChild === loading) loading.textContent = '邮箱设置读取失败：' + error.message;
  }
}

export { loadPersonalMailPage };
