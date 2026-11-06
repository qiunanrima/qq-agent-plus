export function buildMcpPrompt({ messages, toolChoice, nativeApproval }) {
  const routing = 'You are the QQ Agent conversation model. Follow the supplied system messages, role card and memory. '
    + 'All QQ actions and replies use the qq_run MCP server host tools with qq_ prefixes, bound to this conversation. '
    + 'Use qq_send_message with {"messages":["reply text"]}. Native send_message is not a QQ sending tool. '
    + 'System/persona/memory/skills are supplied in context; do not inspect local persona, memory or skill files. '
    + 'Never repeat successful or unknown external writes. Stop after qq_finish succeeds. '
    + 'Do not emit JSON tool requests as text or claim success before actual tool results. '
    + 'Never use native browsers, subagents, task management or background/daemon commands. ';
  const images = 'MCP image results may be saved by the CLI as media files: use read_file with {"Path":"exact returned image path"} to see them (older CLI versions may use view_file/AbsolutePath). '
    + 'The host automatically validates current-run image reads; never use run_command, cat, OCR or local schema files to work around a failed image read or discover tool parameters. '
    + 'OCR is optional for text extraction, not a prerequisite for seeing a picture. '
    + 'If a read-only tool failed and you have replied honestly, call qq_finish with errorAcknowledged:true and a factual summary; never invent ignoreFailures or ignoreErrors. ';
  const policy = nativeApproval
    ? 'Current runtime: ACP with nativeApproval enabled. Configured native tools are run_command, read_file (older name view_file), write_to_file, replace_file_content and multi_replace_file_content. '
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
