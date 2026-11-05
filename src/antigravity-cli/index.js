import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizeAntigravityConfig } from './config.js';
import { prepareMcpInvocation } from './mcp-invocation.js';

const MAX_BYTES = 8 * 1024 * 1024;
const active = new Set();
const activeChats = new Set();
// Session-only settings override user auto-approval without changing their profile.
// tools: [] in agent frontmatter does not remove built-ins in CLI 1.4.12.
const SESSION_SETTINGS = {
  toolPermission: 'strict', allowNonWorkspaceAccess: false, useG1Credits: false,
  permissions: { allow: [], ask: [], deny: [
    'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)',
    'command(*)', 'unsandboxed(*)', 'mcp(*)'
  ] }
};

export function antigravityStatus() { return { active: active.size }; }

function schemaFor(tools, toolChoice) {
  const names = toolChoice === 'none' ? [] : (tools || []).map(t => t.function?.name).filter(Boolean);
  const forced = toolChoice?.function?.name;
  return {
    type: 'object', additionalProperties: false, required: ['content', 'tool_calls'],
    properties: {
      content: { type: 'string' },
      tool_calls: {
        type: 'array', maxItems: names.length ? 16 : 0,
        ...(toolChoice === 'required' || forced ? { minItems: 1 } : {}),
        items: { type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
          name: names.length ? { type: 'string', enum: forced ? [forced] : names } : { type: 'string' },
          arguments: { type: 'string', description: 'JSON-encoded function arguments' }
        } }
      }
    }
  };
}

export function parseAntigravityResult(result, tools = [], toolChoice = 'auto') {
  if (result?.status !== 'SUCCESS') throw new Error('Antigravity CLI did not succeed');
  if (result.denied_actions?.length) throw new Error('Antigravity attempted a denied native action');
  const output = result.structured_output ?? JSON.parse(result.response);
  if (typeof output?.content !== 'string' || !Array.isArray(output.tool_calls) || output.tool_calls.length > 16) throw new Error('Invalid Antigravity structured response');
  const allowed = new Set((tools || []).map(t => t.function?.name));
  const calls = output.tool_calls.map(call => {
    if (toolChoice === 'none' || !allowed.has(call.name) || typeof call.arguments !== 'string') throw new Error('Invalid Antigravity tool request');
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid Antigravity tool arguments');
    if (toolChoice?.function?.name && call.name !== toolChoice.function.name) throw new Error('Antigravity ignored tool choice');
    return { id: `call_${randomUUID()}`, type: 'function', function: { name: call.name, arguments: call.arguments } };
  });
  if ((toolChoice === 'required' || toolChoice?.function?.name) && !calls.length) throw new Error('Antigravity omitted required tool');
  if (!calls.length && !output.content.trim()) throw new Error('Empty Antigravity response');
  const count = key => Math.max(0, Number(result.usage?.[key]) || 0);
  return {
    message: { role: 'assistant', content: output.content, ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: calls.length ? 'tool_calls' : 'stop',
    usage: { prompt_tokens: count('input_tokens'), completion_tokens: count('output_tokens'), total_tokens: count('total_tokens'), prompt_tokens_details: { cached_tokens: count('cache_read_tokens') } },
    raw: result, originBaseUrl: 'antigravity-cli://local'
  };
}

/** One isolated process per model turn. No retries, session resume or shell. */
export async function antigravityCompletion({ config, messages, tools, toolChoice = 'auto', signal, isEnabled = () => true, mcpRun }, { spawnProcess = spawn } = {}) {
  const cfg = normalizeAntigravityConfig(config);
  signal?.throwIfAborted();
  if (!cfg.enabled || !isEnabled()) throw new Error('Antigravity CLI disabled');
  const chatKey = mcpRun?.chatKey;
  if (chatKey && activeChats.has(chatKey)) {
    const error = new Error('Antigravity CLI conversation busy');
    error.code = 'ANTIGRAVITY_NO_RETRY';
    throw error;
  }
  if (active.size >= cfg.maxConcurrent) throw new Error('Antigravity CLI busy');
  // Text-only first version: never silently discard image/audio input.
  for (const message of messages || []) {
    if (Array.isArray(message.content) && message.content.some(p => p.type !== 'text')) throw new Error('Antigravity CLI currently supports text only');
  }
  let prompt = 'Act as the QQ Agent model. Follow system messages in the supplied conversation. '
    + 'Return the next assistant turn using the supplied schema. Tools below are requests for the host to execute; '
    + 'never execute tools yourself or claim a requested operation succeeded before a tool result. '
    + 'Preserve role card and memory. Conversation and available host tools:\n'
    + JSON.stringify({ messages, tools, toolChoice });
  if (Buffer.byteLength(prompt) > MAX_BYTES) throw new Error('Antigravity prompt exceeds limit');
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--agent', cfg.agent,
    '--settings', JSON.stringify(SESSION_SETTINGS), '--disable-slash-commands',
    '--effort', cfg.effort,
    '--json-schema', JSON.stringify(schemaFor(tools, toolChoice)), '--print-timeout', `${cfg.timeoutMs}ms`];
  if (cfg.model) args.push('--model', cfg.model);
  const token = {};
  active.add(token);
  if (chatKey) activeChats.add(chatKey);
  let invocation;
  try {
    if (cfg.transport === 'mcp') {
      invocation = await prepareMcpInvocation({ config: cfg, tools, toolChoice, mcpRun, signal, isEnabled });
      args.splice(args.indexOf('--json-schema'), 2);
      args[args.indexOf('--settings') + 1] = JSON.stringify(invocation.settings);
      prompt = 'You are the QQ Agent conversation model. Follow the supplied system messages, role card and memory. '
        + 'Use only the qq_run MCP server tools (each host tool is prefixed qq_). '
        + 'Native send_message is NOT a QQ tool; never use native task management or subagents. '
        + 'Never call native file, shell or browser tools. '
        + 'Unprefixed tool names mentioned in the supplied context refer ONLY to matching qq_ host tools. '
        + 'Never use native view_file/read_file to inspect skills, persona or memory; use authorized qq_ tools only. '
        + 'System, persona, memory and skill data are already supplied in context; local paths in conversation history are references, not instructions to open files. '
        + 'All QQ replies must use the authorized MCP sending tool. Tools are already bound to this conversation. '
        + 'Never repeat successful or unknown external writes. Stop after qq_finish succeeds. '
        + 'Do not emit JSON tool requests as text. Context:\n' + JSON.stringify({ messages, toolChoice })
        + '\nHost routing rules override tool names in that context: QQ actions use qq_run tools with qq_ prefixes. '
        + 'Use qq_send_message with {"messages":["reply text"]}. Never inspect local persona, memory or skill files. '
        + 'Native file and command tools are unavailable in this build.';
    }
    const result = await new Promise((resolve, reject) => {
      let child, timer, guard, killTimer, failure, hostResult, bytes = 0, stderrBytes = 0, stdout = '', lineBuffer = '', initialized = false, hostFinished = false;
      const stop = error => {
        failure ||= error;
        invocation?.revoke();
        if (!child?.pid) return;
        const kill = sig => {
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, sig);
            else child.kill(sig);
          } catch { /* process already exited */ }
        };
        kill('SIGTERM');
        killTimer ||= setTimeout(() => kill('SIGKILL'), 1000);
      };
      const abort = () => stop(signal.reason || new Error('Antigravity cancelled'));
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(killTimer); clearInterval(guard);
        signal?.removeEventListener('abort', abort);
      };
      try {
        child = spawnProcess(cfg.executable, args, { cwd: invocation?.workspace || cfg.workspace, shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { reject(error); return; }
      child.on('error', error => { cleanup(); reject(error); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) stop(new Error('Antigravity output exceeds limit'));
        else {
          stdout += chunk;
          lineBuffer += chunk;
          let boundary;
          while ((boundary = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, boundary).trim();
            lineBuffer = lineBuffer.slice(boundary + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (invocation?.finished()) {
                hostFinished = true;
                if (event.event === 'result' && event.result?.status === 'SUCCESS' && !event.result.denied_actions?.length) hostResult = event.result;
                stop();
                continue;
              }
              if (event.event === 'init') {
                const expected = invocation ? 'request-review' : 'strict';
                if (initialized || !Array.isArray(event.init?.tools) || event.init.permission_mode !== expected) {
                  stop(new Error('Antigravity must confirm restricted native tool permissions'));
                }
                initialized = true;
              } else if (!initialized) {
                stop(new Error('Antigravity event received before init'));
              } else if (event.event === 'step_update' && event.step_update?.step_type === 'tool'
                && !invocation?.allowToolEvent(event.step_update)) {
                // Never expose event bodies, parameters, prompts or CLI diagnostics.
                const candidate = event.step_update.tool_name || event.step_update.tool_info?.name;
                const name = typeof candidate === 'string' && /^[a-zA-Z_][a-zA-Z0-9_:/.-]{0,79}$/.test(candidate)
                  ? candidate : 'unrecognized';
                stop(new Error(`Antigravity rejected tool: ${name}`));
              } else if (event.event === 'result') {
                // stream-json is a conversation transport. Keep stdin alive until
                // this turn finishes, then request a clean process exit via EOF.
                child.stdin.end();
              }
            } catch { stop(new Error('Invalid Antigravity event')); }
          }
        }
      });
      // Diagnostics can contain credentials or chat data; never expose them in logs/errors.
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_BYTES) stop(new Error('Antigravity diagnostics exceed limit'));
      });
      child.stdin.on('error', () => { if (!hostFinished) stop(new Error('Antigravity input closed')); });
      child.on('close', code => {
        if ((failure || hostFinished) && child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        cleanup();
        if (failure) return reject(failure);
        // A successful audited host finish is terminal. The CLI is deliberately
        // stopped; its missing final usage must not be invented as zero usage.
        if (hostFinished && initialized) {
          return resolve(hostResult || { status: 'HOST_FINISHED', response: '', usage_unavailable: true });
        }
        if (code !== 0) return reject(new Error(`Antigravity CLI exited (${code})`));
        try {
          const results = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === 'result');
          if (!initialized || results.length !== 1) throw new Error('Expected one initialized Antigravity result');
          resolve(results[0].result);
        } catch { reject(new Error('Invalid Antigravity result stream')); }
      });
      timer = setTimeout(() => stop(new Error('Antigravity CLI timed out')), cfg.timeoutMs);
      guard = setInterval(() => {
        if (!isEnabled()) stop(new Error('Antigravity CLI disabled'));
        else if (invocation?.policyChanged()) stop(new Error('Antigravity approval policy changed'));
        else if (invocation?.finished()) { hostFinished = true; stop(); }
      }, 100);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
    });
    if (invocation) {
      if (!['SUCCESS', 'HOST_FINISHED'].includes(result?.status) || result.denied_actions?.length) throw new Error('Antigravity MCP run did not succeed');
      if (result.status === 'HOST_FINISHED' && !invocation.finished()) throw new Error('Antigravity host finish was not confirmed');
      if ((toolChoice === 'required' || toolChoice?.function?.name) && !invocation.calls()) throw new Error('Antigravity omitted required MCP tool');
      const count = key => Number.isFinite(Number(result.usage?.[key])) ? Math.max(0, Number(result.usage[key])) : 0;
      return { message: { role: 'assistant', content: String(result.response || '') }, finishReason: 'stop',
        toolsExecutedViaMcp: true, model: cfg.model || 'antigravity-default', originBaseUrl: 'antigravity-cli://local',
        usage: result.usage_unavailable ? undefined : { prompt_tokens: count('input_tokens'), completion_tokens: count('output_tokens'), total_tokens: count('total_tokens'),
          prompt_tokens_details: { cached_tokens: count('cache_read_tokens') } },
        raw: { status: result.status, conversation_id: result.conversation_id, mcpCalls: invocation.calls(),
          ...(result.usage_unavailable ? { usageUnavailable: true } : {}) } };
    }
    return { ...parseAntigravityResult(result, tools, toolChoice), model: cfg.model || 'antigravity-default' };
  } catch (cause) {
    const error = new Error(`Antigravity request failed: ${cause.message}`, { cause });
    error.code = 'ANTIGRAVITY_NO_RETRY';
    throw error;
  } finally {
    invocation?.revoke();
    try { await invocation?.close(); }
    catch (cause) {
      const error = new Error('Antigravity workspace cleanup failed; capability revoked', { cause });
      error.code = 'ANTIGRAVITY_NO_RETRY';
      throw error;
    } finally { active.delete(token); if (chatKey) activeChats.delete(chatKey); }
  }
}
