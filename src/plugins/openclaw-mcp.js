import fs from 'node:fs';
import path from 'node:path';
import { extractEntries, parseTarGz, sha256Of, unwrapSingleRoot, verifyPluginSignature, verifySha256 } from './install.js';
import { buildPluginTarball, collectPluginFiles } from './pack.js';
import { comparePluginVersions } from './manifest-diff.js';

export const BUILTIN_OPENCLAW_ENTRY = Object.freeze({
  id: 'openclaw-time-format',
  name: 'OpenClaw 时区换算',
  version: '1.0.0',
  description: '将带时区的 ISO 8601 时间转换到指定时区。',
  category: '实用工具',
  tags: ['OpenClaw', '时区'],
  source: '随 QQ Agent Plus 提供',
  compatible: true,
  openclawNative: true
});

export function readBuiltinOpenClawPackage() {
  const dir = path.join(import.meta.dirname, 'builtin-openclaw', 'time-format');
  const buffer = buildPluginTarball(collectPluginFiles(dir));
  return { buffer, item: { ...BUILTIN_OPENCLAW_ENTRY, sha256: sha256Of(buffer) } };
}

export function openClawMarketId(id) {
  return id.startsWith('openclaw-') ? id : `openclaw-${id}`;
}

export async function installOpenClawMarketPackage({ buffer, item, dataDir, getConfig, updateConfig, expectedVersion }) {
  verifySha256(buffer, item.sha256);
  let packageEntries;
  if (item.artifactKind === 'legacy-zip') {
    const { readOpenClawZip } = await import('./openclaw-zip.js');
    packageEntries = await readOpenClawZip(buffer);
  } else {
    packageEntries = parseTarGz(buffer);
  }
  const entries = unwrapSingleRoot(packageEntries);
  const config = getConfig();
  const key = config.plugins?.publishers?.[item.publisher];
  if (key) {
    const result = verifyPluginSignature({ buffer, signature: item.signature, publicKey: key });
    if (!result.ok) throw new Error(`发布者签名校验失败：${result.error}`);
  }
  const id = openClawMarketId(item.id);
  const servers = config.mcp?.servers || [];
  const previous = servers.find((server) => String(server?.id || '').trim() === id);
  if (expectedVersion !== undefined) {
    if (!item.clawHubName || previous?.clawHub?.name !== item.clawHubName
        || previous.clawHub.version !== expectedVersion || previous.enabled !== false
        || comparePluginVersions(item.version, expectedVersion) <= 0) {
      throw Object.assign(new Error('升级要求已停用、版本仍与页面一致，并选择更高版本'), { httpStatus: 409 });
    }
  } else if (previous) {
    throw new Error('已有同名 MCP 服务，请先在 MCP 设置中移除');
  }
  const root = path.join(dataDir, 'openclaw-packages');
  fs.mkdirSync(root, { recursive: true });
  const packageRoot = fs.realpathSync(root);
  const directory = fs.mkdtempSync(path.join(packageRoot, `${id}-`));
  try {
    extractEntries(entries, directory);
    const server = item.openclawNative
      ? readNativeToolPlugin(directory)
      : readOpenClawMcp(directory, item.openclawMcp);
    const source = item.clawHubName ? { clawHub: { name: item.clawHubName, version: item.version } } : {};
    const next = { ...previous, ...server, id, ...source, env: { ...server.env, ...previous?.env } };
    const nextServers = previous ? servers.map((entry) => entry === previous ? next : entry) : [...servers, next];
    updateConfig({ mcp: { servers: nextServers } });
  } catch (error) {
    if (path.dirname(path.resolve(directory)) === packageRoot) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
  return id;
}

function readNativeToolPlugin(root) {
  const manifest = readPackageJson(root, 'openclaw.plugin.json');
  const pkg = readPackageJson(root, 'package.json');
  const entries = pkg.openclaw?.runtimeExtensions ?? pkg.openclaw?.extensions;
  if (typeof manifest.id !== 'string' || !manifest.id || !Array.isArray(entries) || entries.length !== 1) {
    throw new Error('原生工具插件需要清单 ID 和单个 JavaScript 或 TypeScript 运行入口');
  }
  const entry = resolvePluginEntry(root, entries[0], { allowTypeScript: true });
  const runner = path.join(root, '.qq-agent-openclaw-runner.mjs');
  fs.copyFileSync(new URL('./openclaw-tool-runner.mjs', import.meta.url), runner, fs.constants.COPYFILE_EXCL);
  return {
    enabled: false, transport: 'stdio', command: 'node', args: [runner, entry, manifest.id],
    cwd: root, toolMounting: 'meta', permissionIsolation: true,
    env: { QQ_AGENT_OPENCLAW_PLUGIN_CONFIG: '' }
  };
}

function readPackageJson(root, name) {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 256 * 1024) {
    throw new Error(`${name} 必须是 256 KiB 以内的普通文件`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function resolvePluginEntry(root, value, { allowTypeScript = false } = {}) {
  const extension = allowTypeScript ? /\.[cm]?[jt]s$/ : /\.[cm]?js$/;
  if (typeof value !== 'string' || !value.startsWith('./') || !extension.test(value)) {
    throw new Error(`入口必须是插件内的相对 ${allowTypeScript ? 'JavaScript 或 TypeScript' : 'JavaScript'} 路径`);
  }
  const entry = fs.realpathSync(path.resolve(root, value));
  const relative = path.relative(root, entry);
  if (relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
    throw new Error('入口必须是插件目录内的普通文件');
  }
  return entry;
}

export function readOpenClawMcp(pluginDirectory, serverName) {
  if (typeof pluginDirectory !== 'string' || !path.isAbsolute(pluginDirectory)) {
    throw new Error('请填写服务器上的插件绝对路径');
  }
  if (typeof serverName !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(serverName)) {
    throw new Error('MCP 服务名必须由 1–40 位字母、数字、下划线或短横组成');
  }
  const root = fs.realpathSync(pluginDirectory);
  const { mcpServers } = readPackageJson(root, 'openclaw.plugin.json');
  if (!mcpServers || !Object.hasOwn(mcpServers, serverName)) {
    throw new Error('清单没有声明该 MCP 服务');
  }
  const server = mcpServers[serverName];
  const supportedFields = ['transport', 'command', 'args'];
  if (server?.transport !== 'stdio' || server.command !== 'node'
      || Object.keys(server).some((key) => !supportedFields.includes(key))
      || !Array.isArray(server.args) || server.args.length !== 1
      || typeof server.args[0] !== 'string' || !server.args[0].startsWith('./')
      || !/\.[cm]?js$/.test(server.args[0])) {
    throw new Error('仅支持 stdio 服务，启动方式必须是 node ./入口.js（也支持 .mjs 和 .cjs）');
  }
  const entry = resolvePluginEntry(root, server.args[0]);
  return {
    id: serverName,
    enabled: false,
    transport: 'stdio',
    command: 'node',
    args: [entry],
    cwd: root,
    toolMounting: 'meta',
  };
}
