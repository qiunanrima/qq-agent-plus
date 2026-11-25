# Linux 容器

控制台在「设置 → 平台 → Linux 容器」管理启用状态、群聊点名及 CPU、内存、进程数上限。关闭容器会停止其中的进程并保留文件。群聊默认关闭。启用群聊后，当前触发批次须全部来自配置的管理员 QQ，且至少一条消息直接点名机器人。

部署前在 Docker 主机准备 `debian:bookworm-slim` 镜像，由主机管理员运行 `bash ops/linux-container/install.sh`。脚本使用现有的 `qqagent` 用户，通过权限为 0600 的 Unix socket 访问固定容器。容器允许出站公网 IPv4，宿主和常见内网地址由 nftables 拦截。

移除接入时先在控制台关闭容器，再停用 `qq-agent-linux-container.socket`。保留 Docker 容器即可保留文件。

命令从容器内的 /workspace 开始执行，导入的 QQ 附件位于其 inbox 子目录。

安装了 `poppler-utils` 的工作区容器支持从本轮明确指定的目录读取 PDF。文件最多 16 MiB，先读取前 8 页的文字。没有文字时，若已安装下述 OCR 工具，则识别第一页。返回最多 8 KiB 文字。

安装了 `tesseract-ocr`、`tesseract-ocr-chi-sim` 和 `tesseract-ocr-eng` 的容器也可以本地识别 PNG 或 JPEG。单张最多 16 MiB，识别输出最多 8 KiB。识别出的金额和编号应复核后计入报销。
