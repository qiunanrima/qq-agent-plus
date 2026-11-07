import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { requestCliApproval } from './approvals.js';

const LIMIT = 256 * 1024;
const inside = (file, root) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

/** ACP client capabilities are implemented here, never merely advertised. */
export function createAcpNativeClient({ sessionId, workspace, controlRoot, mcpRun, signal, isEnabled, maxCalls, onUnknownWrite = () => {} }) {
  const terminals = new Map();
  let calls = 0;
  const allowed = () => !signal.aborted && isEnabled() && mcpRun.allowed() && !mcpRun.isFinished?.()
    && mcpRun.approvalAllowed?.('native') === true;
  const check = params => { if (!sessionId() || params?.sessionId !== sessionId() || !allowed()) throw new Error('Native request outside active session'); };
  const approve = async (method, params) => {
    check(params);
    if (++calls > maxCalls) throw new Error('Native operation budget exhausted');
    const approved = await requestCliApproval({ category: 'native', chatKey: mcpRun.chatKey, runId: mcpRun.runId,
      tool: method, args: params, signal, allowed, notify: mcpRun.notifyApproval });
    if (!approved || !allowed()) throw new Error('Native operation not approved');
  };
  const safePath = async value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('Absolute native path required');
    const lexical = path.resolve(value);
    let resolved;
    try { resolved = await fs.realpath(lexical); }
    catch { resolved = path.join(await fs.realpath(path.dirname(lexical)), path.basename(lexical)); }
    const control = path.join(await fs.realpath(workspace), '.agents');
    for (const candidate of [lexical, resolved]) {
      if (controlRoot && inside(candidate, controlRoot) && path.relative(controlRoot, candidate).split(path.sep).includes('.agents'))
        throw new Error('Protected native path');
    }
    for (const root of [control, path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.gemini')])
      if (inside(lexical, root) || inside(resolved, root)) throw new Error('Protected native path');
    return resolved;
  };
  const kill = terminal => {
    if (!terminal.child.pid) return;
    try {
      if (process.platform === 'win32') { if (!terminal.exited) execFile('taskkill.exe', ['/PID', String(terminal.child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, error => { if (error) terminal.child.kill('SIGKILL'); }); }
      else process.kill(-terminal.child.pid, 'SIGKILL');
    } catch { /* Process already stopped. */ }
  };
  const close = async () => {
    for (const terminal of terminals.values()) kill(terminal);
    await Promise.all([...terminals.values()].map(terminal => terminal.done));
    terminals.clear();
  };
  signal.addEventListener('abort', () => { void close(); }, { once: true });
  return {
    capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    close,
    async request(method, params) {
      check(params);
      if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
        const file = await safePath(params.path);
        if (method === 'fs/write_text_file' && (typeof params.content !== 'string' || Buffer.byteLength(params.content) > LIMIT)) throw new Error('Invalid native text content');
        if (method === 'fs/read_text_file' && ((params.line != null && (!Number.isInteger(params.line) || params.line < 1))
          || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1)))) throw new Error('Invalid file range');
        await approve(method, params);
        if (await safePath(params.path) !== file) throw new Error('Native path changed after approval');
        let stat; try { stat = await fs.stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && !stat.isFile()) throw new Error('Native path is not a regular text file');
        if (!allowed()) throw new Error('Native operation cancelled');
        if (method === 'fs/write_text_file') {
          try { await fs.writeFile(file, params.content, { signal, mode: 0o600 }); }
          catch { const error = new Error('Native file write outcome unknown; do not retry'); onUnknownWrite(error); throw error; }
          return {};
        }
        if (!stat || stat.size > LIMIT) throw new Error('Native file unavailable or exceeds size limit');
        const text = await fs.readFile(file, { encoding: 'utf8', signal });
        return { content: text.split('\n').slice((params.line || 1) - 1, params.limit ? (params.line || 1) - 1 + params.limit : undefined).join('\n') };
      }
      if (method === 'terminal/create') {
        if (terminals.size >= 4 || typeof params.command !== 'string' || !params.command || /[\0\r\n]/.test(params.command)
          || (params.args != null && (!Array.isArray(params.args) || !params.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))))
          || (params.env != null && (!Array.isArray(params.env) || !params.env.every(item => item && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) && typeof item.value === 'string' && !item.value.includes('\0'))))
          || (params.outputByteLimit != null && (!Number.isInteger(params.outputByteLimit) || params.outputByteLimit < 1))) throw new Error('Invalid native command');
        const cwd = await safePath(params.cwd || workspace);
        await approve(method, params);
        if (await safePath(params.cwd || workspace) !== cwd) throw new Error('Native command directory changed');
        if (!allowed()) throw new Error('Native operation cancelled');
        const terminal = { output: '', bytes: 0, truncated: false, exited: false, status: null };
        const outputLimit = Math.min(params.outputByteLimit || LIMIT, LIMIT);
        const decoder = new StringDecoder('utf8');
        terminal.child = spawn(params.command, params.args || [], { cwd, shell: false, windowsHide: true,
          detached: process.platform !== 'win32', env: { ...process.env, ...Object.fromEntries((params.env || []).map(({ name, value }) => [name, value])) }, stdio: ['ignore', 'pipe', 'pipe'] });
        terminal.done = new Promise(resolve => {
          const output = chunk => {
            terminal.bytes += chunk.length;
            terminal.output += decoder.write(chunk);
            if (Buffer.byteLength(terminal.output) > outputLimit) {
              const tail = Buffer.from(terminal.output).subarray(-outputLimit);
              let start = 0; while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
              terminal.output = tail.subarray(start).toString('utf8'); terminal.truncated = true;
            }
            if (terminal.bytes > 8 * LIMIT) kill(terminal);
          };
          terminal.child.stdout.on('data', output); terminal.child.stderr.on('data', output);
          terminal.child.on('error', () => {});
          terminal.child.on('close', (code, exitSignal) => {
            terminal.output += decoder.end(); terminal.exited = true; terminal.status = { exitCode: code, signal: exitSignal }; resolve();
          });
        });
        const terminalId = randomUUID(); terminals.set(terminalId, terminal);
        if (!allowed()) kill(terminal);
        return { terminalId };
      }
      const terminal = terminals.get(params.terminalId);
      if (!terminal) throw new Error('Unknown run-scoped terminal');
      if (method === 'terminal/output') return { output: terminal.output, truncated: terminal.truncated, ...(terminal.exited ? { exitStatus: terminal.status } : {}) };
      if (method === 'terminal/wait_for_exit') { await terminal.done; return terminal.status; }
      if (method === 'terminal/kill') { kill(terminal); await terminal.done; return {}; }
      if (method === 'terminal/release') { kill(terminal); await terminal.done; terminals.delete(params.terminalId); return {}; }
      throw new Error('Unsupported native client method');
    }
  };
}
