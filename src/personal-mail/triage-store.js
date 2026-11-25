import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const triageFile = dataDir => join(dataDir, 'personal-mail-triage.json');
export const triageDigest = value => createHash('sha256').update(value).digest('hex');

export function triageAccountKey(provider, env) {
  const account = provider === 'qq' ? env.QQ_AGENT_QQ_MAIL_USER : env.QQ_AGENT_GMAIL_REFRESH_TOKEN;
  return provider + ':' + triageDigest(account);
}

export function readTriageState(dataDir) {
  try {
    return JSON.parse(readFileSync(triageFile(dataDir), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
