# Antigravity CLI + 自定义 Agent（实验功能）

本模块默认关闭，仅接管 `purpose: 'chat'` 且没有专用模型 overrides 的调用。
角色卡、记忆、上下文、工具权限、审批、工具执行和 QQ 发送继续由 QQ Agent Plus 管理。
判断、记忆整理、语音、图片等辅助调用仍使用原有 API 配置，不能删除这些配置。
控制台入口：设置 → 实验功能 → Antigravity CLI → 打开 CLI 设置。固化后出现在设置的「模型与服务」菜单。
独立页面可保存路径、Agent、模型、调用限制并查看本机状态；保存和状态刷新不调用 Google。
启停与固化分别保存，不会顺带保存其他页面草稿。页面不能代替服务用户的 CLI 登录。
也可通过安装实例的 `data/config.json` 配置，手改磁盘后重启服务。
不要在源码 checkout 里执行 `manage.sh`。

## 官方依据

- [Headless 与输入输出协议](https://antigravity.google/docs/cli/headless/)
- [自定义 Agent 发现路径](https://antigravity.google/docs/cli/commands/agents/)
- [Agent frontmatter 与工具限制](https://antigravity.google/docs/subagents/)
- [认证（包括 SSH OAuth）](https://antigravity.google/docs/install?tab=cli)

CLI 使用 Google 账号认证或独立 Gemini API Key；本适配器不读取、搬运或记录凭据。
订阅额度与使用范围以当前官方账号条款为准，本实现没有验证 QQ 自动回复的订阅适用性。

## Debian 准备

先阅读 `docs/LINUX.md`、`docs/OPS.md`、`docs/BAOTA.md`，沿用现有服务用户、安装目录和数据目录。
从官方网站安装 CLI，并以运行 QQ Agent 的同一普通用户检查：

```bash
command -v agy
agy --version
agy --help
agy
```

最后一条用于首次登录。SSH 环境按 CLI 提示在本地浏览器打开授权链接，再粘回授权码。
务必确认非交互 systemd 用户服务也能读取登录状态；交互终端成功不代表服务环境成功。
使用 `command -v agy` 得到的绝对路径配置 executable，避免 systemd 的 PATH 差异。

创建独立工作目录，并先验证账号可用：

```bash
mkdir -p "$HOME/antigravity-chat"
cd "$HOME/antigravity-chat"
agy -p '只回复 pong，不调用工具' --output-format json
```

推荐 MCP 路径：QQ Agent 每次在该目录下创建独立临时 workspace，自动安装
`examples/antigravity/qq-mcp/agent.md` 模板和一次性 MCP 配置，不必手工复制 Agent。
实际 QQ 工具只在宿主执行。会话级权限拒绝文件读写、命令、非沙箱执行和浏览器/网络工具，
只放行 qq_run MCP；不修改用户全局配置。详细边界见 [ANTIGRAVITY_MCP.md](ANTIGRAVITY_MCP.md)。
不要添加跳过权限的参数。
不要把工作目录设为源码、数据或凭据目录。

## 配置

在原有 config.json 顶层合并以下字段，不要覆盖整份配置：

```json
{
  "antigravityCli": {
    "enabled": true,
    "graduated": false,
    "executable": "/home/qqagent/.local/bin/agy",
    "workspace": "/home/qqagent/antigravity-chat",
    "transport": "mcp",
    "agent": "qq-mcp",
    "model": "",
    "effort": "low",
    "timeoutMs": 60000,
    "maxConcurrent": 1,
    "maxToolCalls": 16
  }
}
```

路径仅为示例，必须替换成实际值。model 留空沿用 CLI 默认模型；固定模型时使用 `agy models` 的实际 ID。
effort 默认 low，可选 low / medium / high；不沿用交互 CLI 中可能较慢的高思考默认值。
enabled 与 graduated 独立，启用不会自动固化，固化也不会自动启用。
配置校验拒绝非法路径/范围；加载时配置无效只停用 CLI，并保留原配置供修复。

在含 `.deployment.json` 的实际安装目录执行 `./manage.sh restart`。
先只放行测试 QQ 会话，验证角色卡、记忆、连续聊天、send_message 以及宿主工具执行结果。
验证关闭/超时后不会继续发出新工具请求，也不会自动重放未知结果。
不能仅凭模板 tools: [] 认定原生工具已禁用；适配器校验权限模式，
拦截非授权工具事件及 denied_actions。Windows CLI 1.4.12 已完成真实 MCP probe 验证。
Debian 13 和 systemd 用户服务仍需现场验收。

## 实现边界与排障

- 每个模型轮次启动独立进程，通过 stdin 发送一条 stream-json user 事件，收到 result 后才关闭输入；不续接 CLI 历史，避免串群。
- MCP 工具加 qq_ 前缀，宿主绑定 chatKey/sessionId 并复用现有技能、finish 屏障、发送审计和工具执行器；完成的工具不会在外层重放。
- MCP init 必须确认 request-review 权限；只允许 qq_run 工具事件。旧 transport=json 路径仍使用 strict，作为兼容选项，不是推荐配置。
- 禁用斜杠命令扩展及自动使用额外 AI credits；不依赖提示词作为执行权限边界。
- 只接受成功退出且恰好一个 SUCCESS result 的运行；工具请求不是工具执行成功的证明。
- 首版只接受文本；图片/音频输入明确报错，不会静默丢失。maxTokens、temperature 与 HTTP thinking 设置暂不映射到 CLI。
- 每个私聊/群聊同时最多一个 CLI；全局并发上限 1..4，默认 1。不同会话隔离，不复用 CLI 历史。
  每次调用最多 60 秒（旧配置更大的值按 60 秒执行），超时撤销工具权限并终止进程，不自动重试。
  每次 CLI 最多执行 maxToolCalls 个工具（默认 16）；满载直接报 busy，不积压后台任务。
- 超时、取消、时间控制关闭或运行开关关闭会终止子进程；Linux 按进程组 TERM，再 KILL。
- stdout/stderr 各限 8 MiB。诊断内容可能包含敏感信息，因此不回传 CLI stderr 或上游错误正文。
- CLI 路径不走 shell，聊天内容不放命令行；不自动重试、不自动切 HTTP 兜底。
- CLI 可自行保存会话到它的用户目录；无状态指不续接上下文，不代表不落盘。
- `src/antigravity-cli/` 独立拥有配置、运行控制、IPC/MCP、协议解析及 `antigravityStatus()` 活跃数。
- MCP 通过现有外部写入状态机发送；遇到未知结果、连接丢失立即撤销该运行的 MCP 能力，不重新连接重放。
- 宿主审计确认 `finish` 成功后，主动终止本轮 CLI 并撤销 MCP 能力，不等其继续调用工具直到超时。
  这种收尾记为 `HOST_FINISHED`；CLI 未返回最终 Token 统计时保留 `usageUnavailable`，不能把它当作零消耗。
- CLI 内部思考/工具轮次的 token 用量由 CLI 完成后统一返回，无法承诺精确的逐 token 硬上限；同时受运行超时和工具调用数限制。

认证失败时以服务用户重新运行 agy；找不到命令时检查 executable 的绝对路径。
输出协议错误时核对实际版本是否支持 stream-json、--agent 和 --json-schema。
不要通过放开工具权限来修复输出格式问题。

## 工具逐次审批

默认仅使用 QQ 宿主工具，原生审批 nativeApproval 默认关闭。独立设置页可分别配置
QQ 宿主工具审批（qqApproval）与原生文件、前台命令审批（nativeApproval）。
开启原生审批时改用 ACP，CLI ≥ 1.4.12；每轮建立独立会话，不复用永久授权。
启动前只读验证专用 PreToolUse 钩子，原生工具强制 force_ask，客户端只接受 allow_once。
没有原始完整参数、会话不符、重复调用 ID、浏览器/原生子代理/后台命令均拒绝。
批准后的命令以服务用户权限执行；此审批功能不是操作系统沙箱。
原生模式不会修改全局设置或迁移登录凭据；检测到额外全局自定义规则、钩子或开启额外 AI 积分消费时拒绝启动。
读取个人 SSH/CLI 凭据目录和本轮 .agents 控制文件也会拒绝。
当前 ACP 链路已通过本地模拟子进程测试；真实 CLI 的审批后执行仍待验证，尚未部署。
注意：只读的 `/hooks` 检查也可能在登录失效时触发 CLI 的授权流程；“不调用模型”不等于“不触发登录”。
检查失败不重试、不接收或保存授权码，需在服务用户自己的终端完成官方登录后再验证。
CLI 设置页可开启 QQ 工具逐次审批（finish 除外），每次绑定当前会话、运行、工具和完整参数。
管理员 QQ 私聊收到提醒，在控制台批准或拒绝；没有配置管理员 QQ 时仍可在控制台审批。
等待计入本轮 60 秒；结束、取消、超时或停用后失效，不永久授权、不重放，不用兜底发送绕过拒绝。
普通 QQ 聊天的角色卡、记忆及技能上下文由宿主提供，不允许原生 view_file 读取它们。

## 查询剩余额度

主页「总览」直接提供「反重力剩余额度」卡片，分别显示模型分组的周额度、5 小时额度、
重置时间及额外 AI 积分。积分为零不表示模型额度耗尽；缺失数据显示未知。
仅点击时运行官方只读 `agy -p /usage --output-format json` 和 `/credits`，
不会启动模型回合、购买积分或开启额外积分消费。要求 CLI >= 1.1.12，
并验证响应为对应命令且 `num_turns: 0`；不回传原始诊断或账号信息。
成功结果缓存 5 分钟并显示查询时间；失败冷却 1 分钟；并发点击共享一次查询。
刷新页面或后台状态轮询只读取服务器缓存，不自动查询账号额度；过期缓存明确标记，需手动刷新。
接口为已认证的 `POST /api/antigravity-cli/quota`（主动查询）和 `GET /api/antigravity-cli/quota`（只读缓存）。

官方依据：[Model quotas](https://antigravity.google/docs/cli/commands/usage/)、
[CLI changelog](https://antigravity.google/docs/changelog)。

## 回滚

将 enabled 改为 false 并重启服务，即恢复原 API 聊天链路。保留 Agent 文件、配置与 CLI 凭据。
运行期通过配置更新关闭时，正在执行的 CLI 会被终止；单纯手改磁盘需要重启才能生效。

## 本地验证

### 本地修复分支：调度、图片与总结

默认并发为 1，繁忙时按 FIFO 排队，最多等待 32 个请求。排队等待最长 60 秒，
获取执行位置后另计本轮最长 60 秒；同一会话不并行。取消、停用、等待超时不启动 CLI，
也不自动重试。状态接口返回 active 与 queued 数量。

MCP 工具返回的 base64 图片转换为标准 image 内容块，不再 JSON 字符串化。
桥接不主动抓取外部图片 URL；不能传递的图片明确返回未传入模型提示。
工具结果整体大小仍受限制。此修复仅验证了协议数据，实际 CLI 的视觉接收仍待实测。

CLI 经 MCP 正常结束但没有提供 finish summary 时，宿主用本轮真实入站消息和已发送回复
生成带 host-fallback 来源标记的简记，不额外调用模型，不覆盖已有总结。

海马维护时将早于昨日、尚未消化的摘要事务性移入同库 episode_archive，退出活跃列表。
归档仍纳入待消化队列；消化成功并提交长期卡后才清除，失败保留。
状态 archivedCount 表示归档条数，pendingDigestion 包括归档待处理项。
禁用或暂停维护不会触发归档、消化或删除；备份仍包含归档表。

```bash
node --test test/antigravity-cli.test.mjs test/antigravity-mcp.test.mjs test/antigravity-mcp-invocation.test.mjs test/llm.test.mjs
node scripts/antigravity-mcp-smoke.mjs
npx eslint src/antigravity-cli src/llm/llm.js src/core/config-legacy.js src/core/orchestrator.js test/antigravity-cli.test.mjs test/fixtures/antigravity-cli.mjs
```

测试 double 仅使用本机 Node 子进程，不登录 Google、不发送 QQ 消息。
