import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunImageAccess } from '../src/antigravity-cli/image-access.js';
import { createAcpPermissionHandler } from '../src/antigravity-cli/acp-permissions.js';
import { listCliApprovals } from '../src/antigravity-cli/approvals.js';

test('only exact current-run MCP image bytes in the current CLI media spool bypass approval', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-access-'));
  const session = '1996c561-1924-4235-9af2-a2ff7ac42804';
  const file = path.join(home, '.gemini/antigravity-cli/brain', session, '.system_generated/steps/2/media_0.jpg');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from('test image bytes');
  await fs.writeFile(file, bytes);
  try {
    const access = createRunImageAccess({ home });
    assert.equal(await access.allows(file, session), false);
    access.observe([{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }]);
    assert.equal(await access.allows(file, session), true);
    assert.equal(await access.allows(file, '966c63e1-36e0-415f-873b-ab1f6c07428d'), false);
    assert.equal(await access.allows(file, '../escape'), false);
    const other = path.join(home, 'schema.json');
    await fs.writeFile(other, bytes);
    assert.equal(await access.allows(other, session), false);
    const permit = createAcpPermissionHandler({ sessionId: () => session,
      mcpRun: { allowed: () => true, approvalAllowed: () => true }, workspace: home,
      signal: new AbortController().signal, isEnabled: () => true, maxCalls: 16, imageAccess: access });
    const request = { sessionId: session, toolCall: { toolCallId: 'image', name: 'view_file', rawInput: { AbsolutePath: file } },
      options: [{ kind: 'allow_once', optionId: 'once' }] };
    assert.deepEqual(await permit(request), { outcome: { outcome: 'selected', optionId: 'once' } });
    assert.deepEqual(listCliApprovals(), []);
    assert.equal((await permit(request)).outcome.outcome, 'cancelled');
    await fs.writeFile(file, 'changed bytes');
    assert.equal(await access.allows(file, session), false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
