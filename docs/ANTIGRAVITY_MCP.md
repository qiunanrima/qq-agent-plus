# QQ Agent 工具 → Antigravity MCP（实验功能）

本模块属于 `src/antigravity-cli/`，默认关闭。配置 `enabled: true, transport: "mcp"` 后，
聊天编排器把本轮已授权工具接到 MCP；辅助模型请求和带 overrides 的调用继续走原 API。
配置、部署、关闭及回滚见 [ANTIGRAVITY_CLI.md](ANTIGRAVITY_CLI.md)。

## 边界

- Orchestrator 把 MCP 回调和原 API 工具循环接到同一个 executeOneTool：复用技能门控、finish 屏障、executeTool、发送审计及未知写入检测。
- 单独集成时可使用 `createQqRunToolMcp({ toolDefs, ctx, authorize })`；不能绕过 Orchestrator 的运行闸门。
- 工具表必须来自本轮已授权 toolDefs；authorize 必须显式提供，承接宿主的技能、finish 屏障、预算和审批等运行闸门，不能在生产中写成无条件 true。
- ctx.chatKey 和 ctx.session.id 固定在宿主；子进程不接收上下文、数据库路径或 QQ 凭据。
- stdio 子进程通过随机本地 Unix socket / Windows named pipe 回调宿主，不开 TCP 端口。
- 每个运行有独立随机 capability token；令牌只进入 MCP 子进程配置，不进入模型提示词和普通日志。
- MCP 工具增加 `qq_` 前缀，避免与 CLI 原生 send_message 等名称冲突。
- 工具串行执行；默认最多 16 次、120 秒。取消或到期关闭端点，并向工具传递 AbortSignal。
- 同一请求 ID 重复提交返回原结果；参数不同则拒绝。执行抛错或取消后的未知结果不重放。
- ledger 是单次运行的诊断状态，不是持久外部写入日志；真实发送仍必须使用宿主原有 outbox/审批状态机。
- 首版以文本为主，MCP 结果按文本转换；多模态输入明确拒绝。原有会话工具审计照常保留。
- MCP 提供工具不代表移除 CLI 原生工具。测试用会话权限拒绝文件、命令、浏览器访问，仅放行 qq_run MCP；不改用户全局配置。

## 无模型、无 QQ 的本地验证

```bash
node --test test/antigravity-mcp.test.mjs
node scripts/antigravity-mcp-smoke.mjs
```

第二条命令实际启动 stdio 子进程，经已有 MCP client 调用 qq_probe，宿主 executeTool 返回 pong。
测试数据使用临时目录，不读取生产 config.json。

## 单次真实 CLI 验证

```bash
# 可选：指定已登录的 CLI 绝对路径
# Windows PowerShell: $env:AGY_EXE = 'C:\path\to\agy.exe'
# Linux: export AGY_EXE=/home/qqagent/.local/bin/agy
node scripts/antigravity-mcp-smoke.mjs --live
```

只有 --live 才发起一次真实 CLI 调用，不自动重试。只暴露无副作用 qq_probe，最多执行一次。
脚本在临时 workspace 配置 qq-mcp Agent 和 qq_run MCP，不修改全局 MCP 或登录状态。
成功必须同时满足 CLI SUCCESS 且宿主 probe 确实执行一次，单凭模型说 pong 不算通过。
失败后停止，先检查协议或配置；不要循环执行 --live。

Windows CLI 1.4.12 拒绝自定义 Agent 中的 `tools: [call_mcp_tool]`，模板不再声明该内建工具。
修正后已完成一次真实 CLI → MCP → executeTool → pong 验证，宿主调用数为 1。
--live 使用实际生产适配器，不再维护单独的调用实现；默认脚本仍不调用 Google。

## 生产接线与验收

每个模型调用拥有独立临时 workspace 和 MCP 能力，完成或取消即撤销并清理。
CLI 返回的正文不被再次解析为工具调用；MCP 已发送的内容不会被发送纠正逻辑重复发送。
聊天编排回归使用假 CLI、真实 stdio MCP 和模拟 sender，验证 send_message 执行一次、
审计存在、finish 后再次发送被拒绝、临时令牌清理。测试不连接真实 QQ。
Debian 13 的用户服务凭据、真实 OneBot 和实际会话仍需小范围现场验收；不能据 Windows 测试认定已部署。
# 本轮图片读取

原生审批的 ACP 模式优先由宿主把图片原始字节写进本轮 workspace 的 `.qq-images/`，
通过 MCP 返回精确的 `read_file({Path: ...})` 调用路径，避免依赖 CLI 自行转存图片的行为。
每张图片按精确路径和 SHA-256 绑定本轮；篡改后不能自动放行，结束时随 workspace 清理。

启用原生审批的 ACP 模式下，CLI 会把 MCP 图像块写入当前会话的
`.system_generated/steps/<数字>/media_<数字>.<图像扩展名>`，再用 `read_file({Path: ...})` 读取
（兼容旧名 `view_file({AbsolutePath: ...})`）。hook 与 ACP 审批均识别这两种调用。
当前 CLI agent 配置仅列出 `read_file`：旧名只在适配层兼容，同时配置两者会被 CLI
解析为同名工具并导致执行器启动失败。废弃的 `multi_replace_file_content` 同样不再配置。
宿主只自动放行本轮成功工具返回、当前 CLI 会话目录内、内容 SHA-256 一致且不经过符号链接的图片。
其他文件读取和命令仍逐次审批；不允许通过命令读取工具 schema 来绕过收尾错误。
OCR 服务失败不代表图像下载失败。已如实回复后，已知只读失败可用
`finish({errorAcknowledged:true,summary:"事实总结"})` 收尾，未知写入和发送失败仍保持原屏障。

