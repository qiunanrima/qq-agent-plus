import { createHash } from 'node:crypto';
import { safeFetch, safeFetchBinary } from '../llm/safe-fetch.js';
import { isSha256, MAX_PLUGIN_ARCHIVE_BYTES, verifySha256 } from './install.js';

const origin = 'https://clawhub.ai';
const dnsTimeoutMs = 8000;

export function clawHubPackageId(name) {
  return 'clawhub-' + createHash('sha256').update(name).digest('hex').slice(0, 20);
}

async function readJson(url, fetchText) {
  const response = await fetchText(url, {
    maxBytes: 128 * 1024, allowPrivate: false, dnsTimeoutMs, signal: AbortSignal.timeout(18000),
    headers: { accept: 'application/json' }
  });
  if (response.statusCode !== 200) throw new Error(`ClawHub 返回 HTTP ${response.statusCode}`);
  if (response.truncated) throw new Error('ClawHub 响应超过大小上限');
  return JSON.parse(response.body);
}

export async function downloadClawHubPlugin(name, version, { fetchText = safeFetch, fetchBinary = safeFetchBinary } = {}) {
  if (typeof name !== 'string' || name.length > 200 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
      || typeof version !== 'string' || version.length > 80 || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(version)) {
    throw new Error('ClawHub 包名或确切版本无效');
  }
  const packageUrl = `${origin}/api/v1/packages/${encodeURIComponent(name)}`;
  const base = `${packageUrl}/versions/${encodeURIComponent(version)}`;
  const [security, resolved] = await Promise.all([
    readJson(`${base}/security`, fetchText), readJson(`${base}/artifact`, fetchText)
  ]);
  if (security.package?.name !== name || security.release?.version !== version
      || security.trust?.blockedFromDownload !== false) {
    throw new Error('ClawHub 安装策略拒绝该版本，或未返回有效的安全状态');
  }
  const artifact = resolved.artifact;
  if (resolved.package?.name !== name || resolved.package?.family !== 'code-plugin'
      || resolved.version !== version || !['npm-pack', 'legacy-zip'].includes(artifact?.kind)
      || !isSha256(artifact.sha256)) {
    throw new Error('仅支持具有 SHA-256 的 ClawHub 原生 npm-pack 或 ZIP 插件');
  }
  if (security.release.artifactSha256 && security.release.artifactSha256 !== artifact.sha256) {
    throw new Error('ClawHub 版本安全记录与下载包指纹不一致');
  }
  const downloadUrl = artifact.kind === 'legacy-zip'
    ? `${packageUrl}/download?version=${encodeURIComponent(version)}`
    : `${base}/artifact/download`;
  const { buffer } = await fetchBinary(downloadUrl, MAX_PLUGIN_ARCHIVE_BYTES,
    AbortSignal.timeout(25000), { allowPrivate: false, allowedDomains: ['clawhub.ai'], dnsTimeoutMs });
  if (!buffer?.length || buffer.length > MAX_PLUGIN_ARCHIVE_BYTES) throw new Error('ClawHub 安装包为空或超过上限');
  verifySha256(buffer, artifact.sha256);
  return { buffer, item: {
    id: clawHubPackageId(name), version, openclawNative: true,
    sha256: artifact.sha256, artifactKind: artifact.kind, clawHubName: name
  } };
}

export async function searchClawHubPlugins(query, fetchText = safeFetch) {
  const q = String(query ?? '').trim();
  if (!q || q.length > 120) throw new Error('请输入 1–120 个字符的搜索词');
  const url = new URL('/api/v1/plugins/search', origin);
  url.search = new URLSearchParams({ q, limit: '12' }).toString();
  const { results } = await readJson(url.href, fetchText);
  if (!Array.isArray(results)) throw new Error('ClawHub 返回了无法识别的搜索结果');
  return results.slice(0, 12).flatMap((result) => {
    const pkg = result?.package;
    if (!pkg || typeof pkg.name !== 'string' || !pkg.name || pkg.name.length > 200) return [];
    return [{
      name: pkg.name,
      title: String(pkg.displayName || pkg.name).slice(0, 100),
      description: String(pkg.summary || '').slice(0, 300),
      version: String(pkg.latestVersion || '').slice(0, 40),
      family: String(pkg.family || '').slice(0, 40)
    }];
  });
}
