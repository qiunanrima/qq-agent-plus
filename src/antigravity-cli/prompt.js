export function buildMcpPrompt({ messages, toolChoice, nativeApproval, platform }) {
  if (platform === 'bilibili') return 'You are the shared Agent backend serving the current Bilibili private conversation. Follow the supplied role card. '
    + 'Use qq_send_message with messages to reply ONLY to the current Bilibili UID, and qq_finish with a nonempty summary to end. '
    + 'Use only the actual host tool catalog. QQ operations, native tools, commands, files, and cross-chat actions are unavailable. '
    + 'Never retry successful or unknown sends. Stop after qq_finish succeeds.\n' + JSON.stringify({ messages, toolChoice });
  if (platform === 'wechat') return 'You are the shared Agent backend serving this WeChat conversation. Follow the role card and supplied context. '
    + 'The qq_run MCP server uses historical qq_ names: qq_send_message sends ONLY to the current WeChat DM; qq_finish ends the turn with a nonempty summary. '
    + 'Use only the actual host tool catalog. No QQ operations or cross-chat actions are available. '
    + (nativeApproval ? 'Native file and foreground command tools require administrator approval for every invocation. Never bypass rejection or start background tasks. '
      : 'Native tools, commands and files are disabled except exact host-owned image reads. ')
    + 'Never repeat successful or unknown sends. Stop immediately after qq_finish succeeds. Do not output tool requests as text.\n'
    + 'If a read-only tool failed and you have replied honestly, call qq_finish with errorAcknowledged:true and a factual summary. Never retry unknown sends or invent ignoreErrors.\n'
    + JSON.stringify({ messages, toolChoice });
  const routing = 'You are the QQ Agent conversation model. Follow the supplied system messages, role card and memory. '
    + 'All QQ actions and replies use the qq_run MCP server host tools with qq_ prefixes, bound to this conversation. '
    + 'Use qq_send_message with {"messages":["reply text"]}. Native send_message is not a QQ sending tool. '
    + 'System/persona/memory/skills are supplied in context; do not inspect local persona, memory or skill files. '
    + 'Never repeat successful or unknown external writes. Stop after qq_finish succeeds. '
    + 'Do not emit JSON tool requests as text or claim success before actual tool results. '
    + 'Never use native browsers, subagents, task management or background/daemon commands. ';
  const images = 'MCP image results provide an exact host-owned path: use read_file with {"Path":"exact returned image path"} to see them. '
    + 'The host automatically validates current-run image reads; never use run_command, cat, OCR or local schema files to work around a failed image read or discover tool parameters. '
    + 'OCR is optional for text extraction, not a prerequisite for seeing a picture. '
    + 'If a read-only tool failed and you have replied honestly, call qq_finish with errorAcknowledged:true and a factual summary; never invent ignoreFailures or ignoreErrors. ';
  const policy = nativeApproval
    ? 'Current runtime: ACP with nativeApproval enabled. Configured native tools are run_command, read_file, write_to_file and replace_file_content. '
      + 'These native tools are separate from the qq_run MCP catalog. Host-tool lists inside conversation context describe QQ host tools, not the entire CLI tool inventory. '
      + 'Old assistant statements or memories that no command/file tool exists are historical observations, not current capability or permission rules. '
      + 'For an explicit user request for server commands or files, request the appropriate native tool and wait for administrator approval; do not simply repeat an old lack-of-access claim. '
      + 'run_command must be foreground (IsDaemon=false); never invent qq_run_command or route native commands through plugin_call. '
      + 'Every native operation requires approval for its complete parameters. A configured tool does not mean an operation is already approved. After denial stop, never bypass it. '
      + 'When asked about tools, distinguish MCP server names, native tools, and ACP transport; do not treat a list containing only qq_run as proof native tools are absent.'
    : 'Current runtime: QQ host tools only. All unprefixed host tool names in context refer to their qq_ equivalents. Native file and command tools are unavailable; never request them.';
  return routing + '\nContext (conversation data):\n' + JSON.stringify({ messages, toolChoice })
    + '\nCurrent host routing and capability rules (apply even if history describes an older runtime):\n' + routing + policy + (nativeApproval ? images : '');
}
