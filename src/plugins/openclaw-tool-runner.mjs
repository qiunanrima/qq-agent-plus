import { Console } from 'node:console';
import { registerHooks } from 'node:module';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [, , entry, pluginId] = process.argv;
function definePluginEntry(definition) { return definition; }

function emptyPluginConfigSchema() {
  return {
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    safeParse(value) {
      if (value === undefined || (value && typeof value === 'object'
          && !Array.isArray(value) && Object.keys(value).length === 0)) {
        return { success: true, data: value };
      }
      return { success: false, error: { issues: [{ path: [], message: 'Expected empty config' }] } };
    }
  };
}

const sdk = 'data:text/javascript,' + encodeURIComponent(
  `export ${definePluginEntry.toString()}\nexport ${emptyPluginConfigSchema.toString()}`
);
function defineToolPlugin(definition) {
  return {
    id: definition.id,
    configSchema: definition.configSchema,
    async register(api) {
      const tools = await definition.tools((tool) => tool);
      if (!Array.isArray(tools)) throw new Error('defineToolPlugin.tools 必须返回数组');
      for (const display of tools) {
        const { name, description, parameters, execute, factory, optional } = display;
        if (factory) {
          api.registerTool((toolContext) => factory({ api, toolContext }), { name, optional });
          continue;
        }
        if (typeof execute !== 'function') throw new Error(`工具 ${name} 缺少 execute`);
        api.registerTool({
          name, description, parameters,
          async execute(toolCallId, args) {
            const value = await execute(args, api.pluginConfig, { toolCallId });
            const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
            return { content: [{ type: 'text', text }], details: value };
          }
        }, { optional });
      }
    }
  };
}
const toolSdk = 'data:text/javascript,' + encodeURIComponent(`export ${defineToolPlugin.toString()}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (['openclaw/plugin-sdk/plugin-entry', 'openclaw/plugin-sdk', 'openclaw/plugin-sdk/compat'].includes(specifier)) {
      return { url: sdk, shortCircuit: true };
    }
    if (specifier === 'openclaw/plugin-sdk/tool-plugin') return { url: toolSdk, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const rawConfig = process.env.QQ_AGENT_OPENCLAW_PLUGIN_CONFIG || '{}';
let parsedConfig;
try {
  parsedConfig = JSON.parse(rawConfig);
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) throw new Error();
} catch {
  throw new Error('QQ_AGENT_OPENCLAW_PLUGIN_CONFIG 必须是 JSON 对象');
}
globalThis.console = new Console(process.stderr);
const plugin = (await import(pathToFileURL(entry).href)).default;
if (plugin?.id !== pluginId || typeof plugin.register !== 'function') {
  throw new Error('OpenClaw 插件入口必须导出与清单 ID 一致的 register 定义');
}
const schema = typeof plugin.configSchema === 'function' ? plugin.configSchema() : plugin.configSchema;
if (typeof schema?.safeParse === 'function') {
  const parsed = schema.safeParse(parsedConfig);
  if (parsed?.success !== true) throw new Error('OpenClaw 插件配置未通过入口校验');
  parsedConfig = parsed.data ?? {};
}
const pluginConfig = Object.freeze(parsedConfig);
const tools = new Map();
const factories = [];

function addTool(tool, allowedNames) {
  if (typeof tool?.execute !== 'function' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name || '')
      || tool.parameters?.type !== 'object' || tools.has(tool.name) || tools.size >= 50
      || (allowedNames && !allowedNames.includes(tool.name))) {
    throw new Error('工具名称须合法、唯一并与工厂声明一致，参数须为 JSON Schema 对象（最多 50 个）');
  }
  tools.set(tool.name, tool);
}

await plugin.register(Object.freeze({
  id: pluginId,
  logger: console,
  pluginConfig,
  registerTool(tool, options) {
    if (options?.optional) return;
    if (typeof tool === 'function') {
      const names = options?.names ?? (options?.name ? [options.name] : []);
      if (!Array.isArray(names) || !names.length || names.length > 50 || factories.length >= 50
          || names.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))) {
        throw new Error('工具工厂必须声明 name 或 names');
      }
      factories.push({ create: tool, names: [...names] });
      return;
    }
    addTool(tool);
  }
}));

let catalog;
function loadTools() {
  catalog ??= (async () => {
    const context = Object.freeze({});
    for (const { create, names } of factories) {
      const result = await create(context);
      for (const tool of Array.isArray(result) ? result : result == null ? [] : [result]) {
        addTool(tool, names);
      }
    }
    return tools;
  })();
  return catalog;
}

async function dispatch({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: pluginId, version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [...(await loadTools()).values()].map(({ name, description, parameters }) =>
        ({ name, description, inputSchema: parameters })) };
    case 'tools/call': {
      const tool = (await loadTools()).get(params?.name);
      if (!tool) throw new Error('工具不存在');
      const result = await tool.execute(String(id), params.arguments ?? {});
      if (!Array.isArray(result?.content)) throw new Error('工具响应缺少 content');
      return { content: result.content, ...(result.isError === true && { isError: true }),
        ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details)
          && { structuredContent: result.details }) };
    }
    default:
      throw new Error('方法不受支持');
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!request || !Object.hasOwn(request, 'id')) continue;
  const response = { jsonrpc: '2.0', id: request.id };
  try {
    const result = await dispatch(request);
    process.stdout.write(JSON.stringify({ ...response, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ...response, error: { code: -32000, message: String(error.message) } }) + '\n');
  }
}
