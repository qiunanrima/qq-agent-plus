import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../core/config.js';

export const credentials = {
  gmail: {
    clientId: 'QQ_AGENT_GMAIL_CLIENT_ID',
    clientSecret: 'QQ_AGENT_GMAIL_CLIENT_SECRET',
    refreshToken: 'QQ_AGENT_GMAIL_REFRESH_TOKEN'
  },
  qq: {
    user: 'QQ_AGENT_QQ_MAIL_USER',
    authCode: 'QQ_AGENT_QQ_MAIL_AUTH_CODE'
  }
};

function readSettings(dir) {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(join(dir, 'settings.enc'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const key = readFileSync(join(dir, 'key'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function saveSettings(dir, settings) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, 'key');
  let key;
  try {
    key = readFileSync(keyFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    key = readFileSync(keyFile);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  const target = join(dir, 'settings.enc');
  writeFileSync(target + '.tmp', JSON.stringify({
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64')
  }), { mode: 0o600 });
  renameSync(target + '.tmp', target);
}

export function createPersonalMailSettings({ dataDir = DATA_DIR, env = process.env } = {}) {
  const dir = join(dataDir, 'personal-mail');

  function runtimeEnv({ includeDisabled = false } = {}) {
    const stored = readSettings(dir);
    const result = {};
    for (const [provider, schema] of Object.entries(credentials)) {
      if (!includeDisabled && stored[provider]?.enabled === false) continue;
      for (const [field, envKey] of Object.entries(schema)) {
        result[envKey] = stored[provider]?.values?.[field] ?? env[envKey];
      }
    }
    return result;
  }

  function status() {
    const stored = readSettings(dir);
    return Object.fromEntries(Object.entries(credentials).map(([provider, schema]) => {
      const present = Object.fromEntries(Object.entries(schema).map(([field, envKey]) =>
        [field, Boolean(stored[provider]?.values?.[field] ?? env[envKey])]));
      const configured = Object.values(present).every(Boolean);
      return [provider, { enabled: stored[provider]?.enabled ?? configured, configured, present }];
    }));
  }

  function update(provider, input) {
    const schema = Object.hasOwn(credentials, provider) ? credentials[provider] : null;
    if (!schema || typeof input?.enabled !== 'boolean' || typeof input.values !== 'object' ||
        !input.values || Array.isArray(input.values)) return '邮箱设置格式无效';
    const stored = readSettings(dir);
    const values = { ...stored[provider]?.values };
    for (const [field, value] of Object.entries(input.values)) {
      if (!Object.hasOwn(schema, field) || typeof value !== 'string' || value.length > 4096 ||
          /[\x00-\x1f\x7f]/u.test(value)) return '邮箱授权字段格式无效';
      const trimmed = value.trim();
      if (field === 'user' && trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return '请输入完整的 QQ 邮箱地址';
      if (trimmed) values[field] = trimmed;
    }
    if (input.enabled && !Object.entries(schema).every(([field, envKey]) => Boolean(values[field] ?? env[envKey]))) {
      return '请先填齐该邮箱的授权字段';
    }
    stored[provider] = { enabled: input.enabled, values };
    saveSettings(dir, stored);
    return null;
  }

  return { runtimeEnv, status, update };
}

export const personalMailSettings = createPersonalMailSettings();
