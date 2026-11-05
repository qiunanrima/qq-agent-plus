// Explicit single live invocation; only a generated scratch file may be approved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { antigravityCompletion } from '../src/antigravity-cli/index.js';
import { listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live for one CLI invocation; no commands or QQ messages are sent.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-approval-live-'));
  const secret = `probe-${randomUUID()}`;
  let expectedFile, approvals = 0, probes = 0, matched = false;
  const controller = new AbortController();
  try {
    const result = await antigravityCompletion({ config: {
      enabled: true, executable: process.env.AGY_EXE || 'agy', workspace: root, nativeApproval: true,
      model: process.env.AGY_MODEL || '', effort: 'low', timeoutMs: 60000, maxToolCalls: 4
    }, signal: controller.signal,
    messages: [{ role: 'user', content: 'This is an isolated file-read permission test, not a QQ chat. Read approval-probe.txt in the current workspace using native view_file. Then call qq_probe with its exact contents as text. This native read is explicitly requested. Do not use shell, other files, or other tools.' }],
    tools: [{ type: 'function', function: { name: 'probe', description: 'Report the exact scratch-file contents for verification.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }],
    mcpRun: { chatKey: 'approval-smoke:local', runId: randomUUID(), allowed: () => true,
      notifyApproval: id => {
        const entry = listCliApprovals().find(item => item.id === id);
        const args = entry ? JSON.parse(entry.preview) : {};
        const approved = entry?.category === 'native' && entry.tool === 'view_file' && args.AbsolutePath === expectedFile && approvals === 0;
        if (approved) approvals++;
        decideCliApproval(id, approved);
      },
      execute: async (name, args) => {
        probes++; matched = name === 'probe' && args.text.trim() === secret;
        return { content: matched ? 'Probe verified; stop now.' : 'Probe did not match.', isError: !matched };
      }
    }
    }, { spawnProcess: (exe, args, options) => {
      expectedFile = path.join(options.cwd, 'approval-probe.txt');
      fs.writeFileSync(expectedFile, secret);
      return spawn(exe, args, options);
    } });
    if (!matched || approvals !== 1 || probes !== 1) throw new Error('Approval smoke did not verify one approved read');
    console.log(JSON.stringify({ ok: true, status: result.raw.status, approvals, probes }));
  } finally {
    controller.abort();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('qq-approval-live-')) throw new Error('Invalid scratch cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
