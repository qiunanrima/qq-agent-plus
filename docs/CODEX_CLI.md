# Codex CLI（ACP 实验功能）

使用 `@agentclientprotocol/codex-acp@2.6.0` 将 Codex CLI 接入聊天后端。
默认关闭；仅接管 `purpose: chat` 且没有专用模型覆盖的请求。API 配置仍供记忆整理、判断、语音等辅助请求使用。

## 安装和登录

沿用现有服务用户，不以 root 新建部署。先阅读 LINUX.md、OPS.md 和 BAOTA.md。
适配器作为独立程序安装，不属于 QQ Agent 的 npm 依赖，也不会由后台自动安装。

```bash
npm install -g @agentclientprotocol/codex-acp@2.6.0
command -v codex-acp
mkdir -p /absolute/codex-chat/codex-home
CODEX_HOME=/absolute/codex-chat/codex-home codex login
```

替换示例路径，确保目录属于服务用户。适配器自带兼容的 Codex 依赖；用于登录的 Codex CLI 需由服务用户准备。
不复制现有凭据。独立 CODEX_HOME 必须是工作目录下的 `codex-home`，不能包含 `config.toml` 或 `AGENTS.md`。
工作目录及父目录不能有 `.codex/config.toml`，不能设为源码、数据、个人 Codex 配置或其他项目目录。
这些限制防止个人 MCP、插件或规则进入机器人运行环境，不通过修改个人配置解除限制。

Windows 建议 executable 填 `node.exe` 的绝对路径，adapterScript 填已安装包的 `dist/index.js` 绝对路径；
不要把 npm 的 `.cmd` 启动器交给 shell 执行。Linux 直接填写 `command -v codex-acp` 返回的绝对路径，adapterScript 留空。

## 控制台

设置 → 实验功能 → Codex CLI → 打开 Codex 设置。保存路径、模型及限制后再启用。
启用前停用 Antigravity CLI；后端拒绝同时启用两个 CLI，不会自动切换。
固化与启用分别保存；固化后入口常驻模型与服务，停用仍保留全部配置与登录状态。
保存与状态查询只检查本机，不调用模型，也不代表账号认证通过。

保存 CLI 路径和工作目录并登录后，点击「获取模型列表」，从下拉框选择，再保存设置。
查询使用已保存的独立 CLI 配置，即使 Codex 停用也可手动查询；不发送 prompt、不挂载宿主 MCP、
不切换聊天后端。打开页面和刷新状态不会自动查询。获取失败保留当前模型，也可手填模型 ID；
留空沿用 CLI 默认。模型列表来自适配器返回的基础模型选项，不硬编码，也不把思考档位拼进模型 ID。
CLI 返回的目录可能包含缓存；列表可见不代表已完成实际模型调用验收。

配置片段（合并，不能替换整份配置）：

```json
{
  "codexCli": {
    "enabled": false,
    "graduated": false,
    "executable": "/absolute/bin/codex-acp",
    "adapterScript": "",
    "workspace": "/absolute/codex-chat",
    "model": "",
    "effort": "low",
    "timeoutMs": 60000,
    "maxConcurrent": 1,
    "maxToolCalls": 16
  }
}
```

## 边界

- 首版只接收文字，图片与音频明确报错。
- 每轮独立 ACP 进程、临时目录、session 和 MCP 授权，不恢复或复用 CLI 历史。
- 只启用 `qq_run` 宿主 MCP；角色卡、记忆、技能限制、发送审计与 finish 屏障继续由宿主管理。
- 原生命令、文件、浏览器和子代理暂不开放；ACP 客户端拒绝原生权限及文件/终端请求，服务端使用只读沙箱并关闭 shell、web search、apps 等功能。
- 当前不提供 Codex 逐次原生审批开关；不能把 agy 的 hook 或 ACP 工具参数直接用于 Codex。
- 全局并发 1..4，每个会话最多一个，满载直接报 busy；每轮最多 60 秒、1..128 个宿主工具请求。
- 超时、取消、禁用与服务退出撤销 MCP 并终止进程树。成功 finish 后立即收尾；未知外部写入不重放，不重连重试，不切 HTTP 兜底。
- stdout/stderr 各最多 8 MiB。聊天内容不进命令行。适配器自身的持久化行为取决于其版本；独立 session 不等于磁盘无记录。
- 尚未映射真实 token 统计，用量保留未知，不能视为零消耗。
- `src/codex-cli/` 拥有配置、运行和认证状态路由；`src/cli/` 是两种后端共用的 ACP/MCP 基础设施，旧 agy 导出保持兼容。

## 验证与回退

```bash
node --test test/codex-cli.test.mjs test/llm.test.mjs
npx playwright test test/browser/codex-cli.spec.mjs
```

离线 fixture 验证权限拒绝、MCP、finish、取消与超时，不消耗模型额度。
真实环境需先以服务用户完成登录，然后只放行测试会话，确认角色卡、连续聊天、宿主工具、发送和关闭后无新写入。
未完成真实模型与线上验收前保持实验状态，不固化。
回退时停用 codexCli.enabled，聊天恢复 API；若要回到 agy，再单独启用 agy。配置、记忆、消息存档与专属登录目录均保留。

协议依据：[适配器](https://github.com/agentclientprotocol/codex-acp)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。
