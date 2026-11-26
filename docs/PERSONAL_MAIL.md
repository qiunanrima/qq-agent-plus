# Gmail 与 QQ 邮箱

管理员在 QQ 私聊明确查询邮件、会议或会前准备时，Agent 可以用 `personal_mail_search` 搜索已授权的邮箱。邮箱搜索可和手机日历、独立 Linux 工作区的文件搜索及摘录在同一轮使用。搜索结果包含来源、收信时间、主题、摘录和附件名。

## 控制台授权

通过现有控制台隧道打开「个人邮箱」。分别填入授权字段，选择是否允许 Agent 查阅，保存后点「测试连接」。测试可在停用时执行。保存后输入框留空，原值仍保留；替换时填新值即可。控制台保存的凭据以 AES-256-GCM 加密，接口仅返回配置状态。启用、停用和替换即时生效。

## 环境变量授权

将所用邮箱的变量放进 Agent 服务用户拥有的 `~/.config/qq-agent/personal-mail.env`，权限设为 0600。值包含空格时用引号。QQ Agent Linux 用户服务可以通过一个 drop-in 载入此文件：

```ini
[Service]
EnvironmentFile=-%h/.config/qq-agent/personal-mail.env
```

保存后以服务用户运行 `systemctl --user daemon-reload` 和 `systemctl --user restart qq-agent-linux`。两家独立启用。删除对应邮箱变量并重启可撤销接入。

| Gmail | QQ 邮箱 |
| --- | --- |
| `QQ_AGENT_GMAIL_CLIENT_ID` | `QQ_AGENT_QQ_MAIL_USER` |
| `QQ_AGENT_GMAIL_CLIENT_SECRET` | `QQ_AGENT_QQ_MAIL_AUTH_CODE` |
| `QQ_AGENT_GMAIL_REFRESH_TOKEN` | |

Gmail 使用开启 Gmail API 的 Google Cloud OAuth 客户端，对目标 Gmail 账号获取离线刷新令牌，授权范围为 `https://www.googleapis.com/auth/gmail.readonly`。Google OAuth 客户端须能够为该账号授权。如果使用 OAuth Playground，请配置自己的客户端，并在 Google Cloud OAuth 客户端中登记 Playground 回调地址。见 [Google 离线授权说明](https://developers.google.com/identity/protocols/oauth2/web-server#offline) 和 [Gmail 权限说明](https://developers.google.com/workspace/gmail/api/auth/scopes)。

QQ 邮箱使用完整邮箱地址。在 QQ 邮箱设置开启 IMAP，并生成第三方客户端授权码。Agent 用该授权码通过 TLS 连接 `imap.qq.com:993`，以只读方式打开收件箱。见 [QQ 邮箱帮助中心](https://service.mail.qq.com/)。

## 查询范围

默认查 14 天，每家返回最多 3 条。可以明确指定邮箱和时间范围，最多查近 90 天、每家 6 条。Gmail 返回线程链接；QQ 邮箱返回主题、发件人、日期和 Message-ID。Gmail 使用服务端摘要；QQ 邮箱有纯文本正文时才返回摘录。首版收取附件名称供匹配，附件文件内容需要另行导入到授权的容器目录。

## Gmail 邮件跟进

在管理员 QQ 私聊可以要求 Agent 跟进指定 Gmail 线程，例如「这封报价邮件周五下班前还没回，就帮我拟一封催办」。Agent 先确认线程和期限，后台约每十分钟检查。如果同一线程收到回复，私聊回报；到期仍未回，私聊提供草稿。邮箱不可读时会报告无法核实。可以在私聊查询或取消尚未产生结果的跟进。

## Gmail 日历邀约

邀约发送使用同一 Google OAuth 客户端另行取得的离线刷新令牌，授权范围为 `https://www.googleapis.com/auth/gmail.send`。将令牌作为 `QQ_AGENT_GMAIL_SEND_REFRESH_TOKEN` 写入上面的服务环境文件并重启。保留现有 `QQ_AGENT_GMAIL_REFRESH_TOKEN`，它继续用于搜索与跟进。移除发送变量并重启即可停用发信。

在管理员 QQ 私聊先确认会议标题、开始与结束时间、时区和组织者 Gmail 地址。发送时可说「发送日历邀请给 attendee@example.com」，在这条消息中列出所有收件人。Gmail 接受请求后返回邮件编号。结果未知时，先在已发送邮件中核对，再决定如何处理。手机日程写入会单独返回回执。
