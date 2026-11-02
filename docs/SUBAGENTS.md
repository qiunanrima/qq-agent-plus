# 受限子代理

设置 → 实验功能 → 受限子代理，开启后主聊天模型获得 `delegate_research(task, context?)`。旧安装默认关闭。启用和 `graduated` 固化状态独立；停用会撤回工具、取消在途请求，已记录的日志保留。仅有生命周期设置，没有业务管理页面，调用记录沿用会话详情与运行日志。

子代理使用当前聊天模型，独立上下文只包含任务、显式提供的必要索引/上下文和自己查到的资料，不复制主聊天历史、系统提示词或管理员配置。主模型应提供明确的问题、人物QQ或记忆索引；资料不足时子代理可以说明未找到。子代理结果只返回主模型，由主模型决定是否回复、采纳什么内容。

权限采用硬编码白名单与当前角色/会话已有工具权限的交集：`search_web`、`fetch_url`、`knowledge_search`、`memory_query`、`person_memory_lookup`、`persona_background_lookup`、`personality_lookup`、`hippocampus_lookup`、`memory_card_list`、`memory_card_lookup`、`semantic_memory_lookup`。保留原工具的记忆可见性、角色隔离、网页访问限制及技能门禁。插件/MCP工具不加入白名单，即使同名也不能替换。没有发送、写记忆、管理账号、执行技能或再次委派的能力；模型伪造工具名时宿主直接拒绝。

固定限制：全局最多2个并发子代理，同一运行最多1个同时执行、2次调用尝试；每次45秒、3轮模型、4次只读工具调用、累计16000 Token。任务与上下文分别最多2000字符，每个工具结果最多6000字符，最终结果最多4000字符。第三轮仅可结束，不再执行工具。子代理模型调用不自动重试。

调用计入所属运行的 `auxiliaryUsage`，与聊天、背景扫描及人格核验共享 `maxRunTokens`，并在辅助模型请求前估算输入和限制输出；每日台账只计一次。联网次数计入原会话。Token预算基于输入估算与服务商返回的实际用量，不能保证服务商计数与估算完全一致。

日志默认info级别，前缀 `[subagent]`，沿用父运行traceId：

```text
[subagent] called id=abc12345 session=... chat=group:...
[subagent] tool id=abc12345 session=... chat=group:... name=search_web
[subagent] tool_finished id=abc12345 session=... chat=group:... name=search_web status=ok
[subagent] finished id=abc12345 session=... chat=group:... status=completed rounds=2 tools=1 durationMs=...
```

拒绝调用也记录called与failed；取消/超时记录cancelled，非法工具记录tool_denied。日志不记录任务、参数、抓取正文、结果或异常原文。会话JSON中的 `subagentRuns` 只保留ID、开始时间、轮数、工具次数、状态和耗时；普通主工具调用记录中仍能看到主模型提交的任务及返回摘要。无需新增数据库、定时器或独立进程。

回滚：先停用 `subagent.enabled`，确认在途子代理结束，再回退代码；历史会话与日志保留。`graduated` 不绕过权限、预算或启用检查。
