# 搜索工具契约

模型通过后端的 `search_web` 搜索，必要时用 `fetch_url` 读取网页，再给出答案与来源链接。模型不自行请求搜索引擎页面。

```json
{ "query": "要查的简洁搜索词", "count": 5 }
```

- `query`：必填；去除控制字符、CQ码并折叠空白，最多120字符。这个长度是项目自身的统一限制，不能据此声称是某家供应商的当前限制。
- `count`：可选整数，默认5，范围1–20；非法值不调用搜索服务。
- `meme`：保留原有可选的梗补搜开关，不影响数量约定。
- 返回 `query`、`requestedCount`、`results`；每条结果提供 `title`、`url`、`snippet`，部分后端另有来源信息。结果不超过本次请求数量。

数量按请求隔离，群聊与私聊并发调用不修改全局配置，不会相互覆盖。数量会传给支持该参数的后端；适配器仍遵守各上游原有数量上限。结果不足时允许少于请求值，不编造补足。聚合与梗补搜也统一遵守本次返回上限。

`fetch_url({"url":"https://…"})` 返回实际 URL、HTTP 状态、截断标记与正文；最多向模型提供20000字符。沿用现有的地址校验、重定向检查、响应体限制、超时和取消机制，不能读取本机/内网。标题、摘要与正文都经过提示词段头清洗。

搜索源、鉴权和排序由管理员配置的后端适配器决定。这次没有切换任何供应商或密钥：后端仍可使用现有 API、聚合搜索或兼容的搜索页解析。工具名称不改变供应商自己的 API 路径/协议字段，例如 DeepSeek Responses 的 `web_search` 类型保持原样。

提示词要求：先构造搜索词，搜索得到摘要，必要时读取正文，再组织答案并附相关来源。没有读到正文就明确区分为摘要；抓取失败不假装读过。被问到实现时，只说明已有依据的信息，不猜测未提供的供应商、鉴权、排序或源码。普通聊天不主动讲工具流程。

场景规则只在词语含义不明且影响理解时引导查梗，先查本群梗库，再按需搜索；
普通单词不强制搜索，不要求汇报搜索次数。图片直链交给看图工具，不当网页正文抓取。

## 实验功能：网页渲染

常规 `fetch_url({"url":"https://…"})` 继续做 HTTP 抓取。只有在 **设置 → 实验功能 → 网页抓取 · 浏览器渲染** 启用后，
模型才会看到可选参数 `render`。遇到依赖 JavaScript 的正文，可调用 `fetch_url({"url":"https://…","render":true})`。
请求了渲染时，结果用 `rendered` 标记实际是否读到渲染后的正文。渲染忙、引擎不可用或渲染失败时返回 HTTP 内容。
联网搜索总开关仍然生效。停用实验会结束进行中的渲染，普通 HTTP 抓取可以继续。

Chromium 后端通过 `QQ_AGENT_CHROMIUM_SOCKET` 连接独立的 systemd 用户服务。配置 socket 后，渲染请求交给 Chromium，失败时返回 HTTP 内容。Chromium 以新会话按需启动，退出后释放内存。Unix socket 只允许服务账号访问，浏览器代理在连接前校验并固定公网 IP，原站的 HTTPS 与跨源规则由浏览器处理。

如在 Debian 上部署，先安装 `chromium-headless-shell`。在 `~/.config/systemd/user/` 写入同名的 `qq-agent-chromium.socket` 和 `qq-agent-chromium.service`，并把路径改为实际安装目录。下面的内存参数适合用作 2 GiB 实例的初始测试值。

```ini
# qq-agent-chromium.socket
[Socket]
ListenStream=%t/qq-agent-chromium.sock
SocketMode=0600

[Install]
WantedBy=sockets.target
```

```ini
# qq-agent-chromium.service
[Service]
WorkingDirectory=/mnt/data/qq-agent/app
ExecStart=/bin/bash /mnt/data/qq-agent/app/scripts/chromium-worker.sh
MemoryHigh=320M
MemoryMax=384M
MemorySwapMax=0
OOMPolicy=kill
```

为 QQA 服务设置 `Environment=QQ_AGENT_CHROMIUM_SOCKET=%t/qq-agent-chromium.sock`，重载 systemd 后启用 socket 并重启 QQA。另机部署时可通过 SSH 转发 Unix socket。未配置 socket 时，仍可使用 Obscura 后端。

Obscura 是独立的 Rust + V8 浏览器引擎。上游 [98 个公开网页测试](https://github.com/h4ckf0r0day/obscura-benchmark#real-world-corpus-vs-headless-chrome)
报告 Obscura 的峰值 RSS 中位数约 64 MB，Chromium 约 201 MB。本站点、系统和并发结果需单独测量。
实验按需启动一个进程，单次浏览器阶段最多 15 秒，退出后释放进程。V8 老生代上限为 64 MiB，进程总 RSS 还包含其他内存。
普通抓取无需安装引擎。

在部署机为服务用户准备 [Obscura v0.2.7 官方二进制](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.7)，
校验发布资产的 SHA-256，将 `QQ_AGENT_OBSCURA_BIN` 设为服务环境里的二进制绝对路径，重启服务后再启用实验。
Obscura 才会在渲染期间创建临时环回 CDP 监听，使用随机端口和单次令牌，处理完即结束。
Obscura 直接用原始网址打开公开网页，按浏览器的跨源规则加载脚本、CDN 和接口，页面脚本可发起浏览器请求。
浏览器沿用自身的内网地址拦截，每次使用新的会话。部分依赖登录、特殊浏览器 API 或反自动化挑战的页面仍可能读不到正文。
该入口目前仅提供启停，仍处于实验期。
回退时可关闭实验；需要移除引擎时删除服务环境变量并按现有流程重启服务。

## 兼容与运维

模型工具清单只展示新名。旧 `web_search` / `web_fetch` 调用保留为内部别名，旧技能的工具白名单同样生效；这不会放宽技能对其他工具的限制。新旧名字均受搜索总开关约束，属于只读工具，并计入联网用量。控制台同时显示旧日志，并合并新旧用量统计。

每日动态研究工具也使用新接口及数量约定。供应商测试、插件后端及配置字段仍使用现有内部接口，不需要改旧配置或重新安装技能。

验证覆盖各搜索适配器契约、真实聊天执行、并发数量、非法数量、少量结果、聚合出口、旧技能别名、取消与SSRF，以及控制台设置/用量的桌面和窄屏烟测。没有使用生产密钥或在线付费搜索；测试通过不代表验证了当前供应商账号额度或服务器网络。
