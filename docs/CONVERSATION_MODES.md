# Conversation Modes

The conversation engine has four runtime-selectable modes. The global default
can be overridden for each allow-listed group — turn off `conversation.unifiedMode`
(the「统一设置响应概率」checkbox in the console) first; with it on, per-group
overrides are ignored. Private chats use the global mode.
Changing a mode does not require a restart.

## Modes

### Legacy

Only the configured mention, keyword and probability policy can start a model
run. This preserves the original behavior and is the rollback mode.

### Threaded

After the agent sends a message, the intended participant receives a short
continuation window. A reply to the bot also triggers deterministically. Other
messages continue to use the legacy trigger policy.

### Lifecycle

An initial legacy trigger opens a locally persisted conversation lifecycle.
While it is `active` or `listening`, every incoming batch in that chat reaches
DeepSeek, which can reply or remain silent.

The default lifecycle deadlines are:

- `listening`: close after 5 minutes without another processed batch.
- `active`: close after 20 minutes without another processed batch.
- hard lifetime: 30 minutes from the original opening time and never extended.
- `rollover_armed`: after an active hard-limit closure, the next arbitrary
  message may resume from the checkpoint for up to 10 minutes.

These are application deadlines. No HTTP request or model process is kept open
while waiting.

### 感知唤醒（Perception）

在「设置 → 聊天 → 对话模式」选择「感知唤醒」，也支持关闭统一设置后按群选择。
这是独立聊天模式，不改变现有完整生命周期模式，切换无需重启。

普通群消息按现有防抖批次进入专用记忆总结模型，只返回相关消息ID、话题及是否值得参与。
必须先在「设置 → 记忆」选择总结模型提供商和模型；即使记忆整理设为跟随聊天模型，
感知也使用选定的专用模型，不回退主模型。未配置或判断失败会记录错误，保留现有标记。
@、回复机器人、私聊和人工唤醒直接运行，不必先经过感知；主动任务保留原有触发策略。

感知输入只有角色简述、本批消息摘录、少量积累标记和最近话题；没有工具或完整记忆快照。
值得留意与值得开口独立判断，不按标记次数机械唤醒。
标记保存在 `perception.sqlite`，按会话与角色隔离，最多60条、24小时，重启保留。
主模型唤醒时一次性接收积累标记与本批相关原消息，不重复注入本批消息，
不携带未标记的历史或完整生命周期供应商记录。正常记忆与角色提示词照常提供。
成功后只消费本次快照内的标记，保存最近话题；失败保留标记，不自动重试未知外部写入。
最近成功运行五分钟内作为活跃话题供感知参考，其余时间仍由小模型决定弱注意或唤醒。

日志 `[perception]` 包含会话、打标数、是否唤醒及积累条数，不输出聊天正文。
感知用量计入辅助模型与每日用量；没有唤醒时会话记为不回复，主聊天模型调用数为零。
切回其他模式停止感知且保留标记。一键清除全部记忆会先备份再清除感知标记与话题。
运维备份包含该数据库。回退可直接选择原来的聊天模式。

## DeepSeek Context

Lifecycle mode stores an append-only provider transcript in SQLite. Each new
model request uses:

```text
stable system prompt + prior dialogue/tool transcript + latest context snapshot + current message batch
```

Only real conversation input, assistant calls and tool results are appended to
the transcript. Memory snapshots (hippocampus, impressions, personality and skill
indexes, state and handoff/checkpoints) are supplied with the current user message
and omitted from the persisted turn. Each new wake therefore sees one current
snapshot rather than accumulating stale versions. Within a wake, the snapshot
remains available for every tool round. Queried tool results are retained.

The stable system prompt and dialogue remain reusable; removing snapshots means
cross-wake requests no longer promise the exact full previous-request prefix for
DeepSeek caching. Provider
`reasoning_content` is retained only inside the active lifecycle so tool calls
can continue correctly. Raw lifecycle transcript is deleted when the lifecycle
closes or rolls over; the structured checkpoint remains.

The transcript is also rolled over when:

- the system prompt or tool schema changes;
- a turn contains inline image data;
- the preceding request reached the configured input-token threshold (32000 by default);
- the configured transcript character budget is exceeded.

The input-token threshold is checked before the next message batch, using the
provider's actual previous `prompt_tokens`. It is the primary lifecycle budget;
the character limit is retained as a format-independent fallback.

The default cumulative Agent-run budget is 160000 tokens. Before another tool
round, the orchestrator estimates its input from the preceding request and reserves
output headroom. If the projected run would cross the limit, it commits the completed
work as a budget stop rather than throwing after confirmed sends.

## Persistence And Recovery

`messages.sqlite` contains:

- `conversation_threads`: current state and deadlines;
- `thread_turns`: active lifecycle provider messages;
- `thread_checkpoints`: append-only structured state with source message IDs.

The recovery loop evaluates persisted deadlines every five seconds, so process
restarts do not reset active, listening or rollover states.

The active provider transcript is temporary working state. Closing or rolling a
lifecycle deletes it from `thread_turns`; the normal per-run audit files retain
their existing provider response records according to session retention policy.

## Runtime Identity And Boundaries

The runtime uses three different identifiers and persistence scopes:

- `chatKey` identifies the QQ conversation, such as `group:10000005`.
- `sessionId` identifies one Agent execution for one claimed message batch.
  It owns the timeout, tool rounds, usage, send audit and success/failure result.
- `threadId` identifies the lifecycle shared by multiple Agent Sessions. It owns
  lifecycle deadlines, the append-only provider transcript and checkpoints.

One lifecycle therefore normally contains multiple Session records:

```text
QQ messages
  -> randomized debounced message batch
  -> one Agent Session
  -> read prior thread_turns by threadId
  -> call model and tools
  -> atomically acknowledge batch + append transcript + checkpoint
  -> end Agent Session
  -> keep lifecycle thread active/listening for the next batch
```

The Session boundary is intentional. It provides an isolated message lease and
retry boundary without keeping an HTTP request or model process alive during the
idle part of a lifecycle. It does not reset model context.

The console keeps those execution boundaries but groups `threaded` and
`lifecycle` Sessions by `threadId`. One thread appears as one list item with an
internal batch timeline. Selecting a batch shows that run's exact audit data.
The waiting Session is attached to the current thread as soon as its debounce
window starts, so it does not appear as a temporary standalone window. New
Sessions refresh the list without replacing the Session currently being read.
The batch timeline scrolls horizontally and preserves both its horizontal
position and the detail pane's vertical position when another batch is selected.
Legacy Sessions remain one item per run because they do not share a thread.

Each Session persists a structured trigger kind instead of relying on display
text. The initial lifecycle trigger distinguishes `mention`, `keyword`,
`probability` and `all`; later batches use `lifecycle`, `rollover` or `reply` as
appropriate. The console shows the origin trigger for the grouped lifecycle and
the actual trigger kind for every batch in its timeline.

The Session API overlays the persisted audit record with the matching current
thread state. Lifecycle views therefore expose active/listening/rollover/closed
state, effective and hard deadlines, a live remaining-time display, accumulated
Token usage and estimated cost across all Sessions sharing the `threadId`.
Historical threads are reported as closed even if their final Session snapshot
was written while the thread was still active.

The pre-run debounce is a random duration between `wakeDelayMinMs` and
`wakeDelayMaxMs` for each newly scheduled batch. The defaults are 8000 and
12000 milliseconds. Repeated messages redraw the delay while
`maxBatchWaitMs=20000` still caps total aggregation time from the first pending
message. Explicit manual and drain delays remain deterministic.

## Context Inspector

Each new Session audit records:

- the provider transcript injected from the existing lifecycle;
- the latest complete model request (`messages`, tool schemas and request options);
- exact provider token usage for every tool round, including cached input tokens;
- provider `reasoning_content` when the selected model returns it.

The context inspector's top metrics are totals for the selected Session, not the
last model round: first-call and overall cache hit rates, total input/output/cache
tokens, tool calls, web operations and estimated cost. The table below remains
the per-round view. Session cost uses the same per-call model, provider and
peak/off-peak pricing logic as the Usage page.

The request snapshot omits inline image bytes to avoid duplicating large base64
payloads in every Session file. The message structure, MIME type and original
request character count remain visible. Token values come from provider usage
instead of being estimated from character counts.

## Directed Reply Guard

When a run is triggered by a private message, an @mention, a reply/quote of the
bot, or a message that names it, and the model ends the run without calling
`send_message`, the text it produced is never visible in QQ. The orchestrator
then makes one correction request with `send_message` as the only available
tool. If that still produces no send, it sends a fixed fallback message instead
of forwarding the draft.

The guard never runs for proactive or manual runs, never sends when the outbox
may already contain a delivery, and leaves ordinary group conversations free to
stay silent. Disable it with `conversation.replyGuardEnabled: false`.

A poke aimed at the bot counts as a directed interaction: it is treated as an
@mention for tier selection, pacing bypass, the budget degrade gate and this
reply guard. Set `conversation.pokeReplyEnabled: false` to process pokes like
ordinary group messages instead. Pokes between other members are unaffected.

## Operational Guidance

Start with lifecycle mode on one active group. Compare it with threaded and
legacy groups using first-call cache rate, continuation wake rate, silent model
runs, response latency and duplicate-send counters. The existing message lease
and held-delivery rules remain authoritative in all three modes.
