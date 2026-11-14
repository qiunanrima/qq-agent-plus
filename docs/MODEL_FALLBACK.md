# 模型自动回退（实验）

在设置 → 实验功能启用「模型自动回退」，打开「回退设置」用上移/下移调整顺序，每次调整独立保存。
默认关闭；默认顺序 `agy → codex → api`。固化只让设置入口常驻，不改变运行开关。

独立模块 `src/model-fallback/` 拥有配置校验与回退运行逻辑；配置为
`modelFallback: { enabled: false, graduated: false, order: ['agy', 'codex', 'api'] }`。
通过已认证的 `/api/config` 读取和保存配置；不增加数据库或后台模型探测。
关闭时保留配置，正在运行的回退请求会被取消。

只接管没有专用 overrides 的普通聊天请求。各后端使用各自已保存的模型配置。
跳过未启用的 CLI、没有宿主授权上下文的 CLI、仅支持文字但请求含图片的 CLI，
以及未配置地址或模型的 API。CLI 失败不在原后端重试，API 保留原有重试和备用模型。
AGY 返回的模型容量不足、容量耗尽及显式 Error 诊断即使被协议标为成功，也按失败处理；普通 warning 不触发回退。
每个新请求重新按保存的顺序尝试，不永久切换首选后端。

QQ 宿主工具一旦开始执行（包括失败和结果不明），本次失败不再切换后端。
原生权限检查和原生工具调用不作为阻止回退的条件。用户取消、权限撤销、时间门禁
和功能停用不触发回退。日志记录切换后端，响应携带实际 backend，记账归属实际渠道。

回滚：停用回退功能。如果同时启用了两个 CLI，先停用一个，再关闭回退；关闭后沿用
原来的 CLI 互斥规则。回滚旧版本前同样先停用回退和其中一个 CLI，保留配置及消息数据。

验证：`node --test test/model-fallback*.test.mjs test/codex-config.test.mjs test/llm.test.mjs`；
UI：`npx playwright test test/browser/model-fallback.spec.mjs`。
