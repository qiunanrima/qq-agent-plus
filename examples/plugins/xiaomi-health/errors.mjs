// Only errors constructed locally may cross the plugin boundary. Upstream messages may contain tokens.
export class HealthError extends Error {
  constructor(message, code = 'E_HEALTH') { super(message); this.code = code; }
}
export function hostError(error) {
  const text = String(error?.message || '');
  if (/timeout|超时|ETIMEDOUT/i.test(text)) return new HealthError('请求小米服务超时，请稍后重试', 'E_TIMEOUT');
  if (/E_DOMAIN|白名单/.test(`${error?.code} ${text}`)) return new HealthError('小米服务域名被宿主白名单拒绝，请更新宿主和插件', 'E_DOMAIN');
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return new HealthError('无法解析小米服务域名，请检查服务器 DNS', 'E_NETWORK');
  if (/内网|本机地址|SSRF/.test(text)) return new HealthError('小米服务地址被宿主网络安全检查拒绝，请检查 DNS 或代理配置', 'E_NETWORK');
  if (/证书|certificate|TLS|SSL/i.test(text)) return new HealthError('小米服务 TLS 连接失败，请检查服务器时间和证书环境', 'E_NETWORK');
  return new HealthError('宿主请求小米服务失败，请检查服务器网络与插件运行状态', 'E_HOST');
}
export function publicError(error) {
  return error instanceof HealthError ? { code: error.code, message: error.message }
    : { code: 'E_HEALTH', message: '健康接口响应异常，请更新插件或重新扫码' };
}
