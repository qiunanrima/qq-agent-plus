import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { toMcpContent } from './mcp-content.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Only images returned by this run may be read from the CLI's media spool. */
export function createRunImageAccess({ home = os.homedir() } = {}) {
  const images = new Set();
  return {
    observe(content) {
      for (const part of toMcpContent(content)) {
        if (part.type !== 'image' || images.size >= 32) continue;
        const bytes = Buffer.from(part.data, 'base64');
        if (bytes.length && bytes.length <= 4 * 1024 * 1024) images.add(digest(bytes));
      }
    },
    async allows(file, sessionId) {
      if (!images.size || typeof file !== 'string' || !path.isAbsolute(file)
        || !/^[a-f0-9-]{36}$/i.test(sessionId || '')) return false;
      const root = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'steps');
      const target = path.resolve(file), relative = path.relative(root, target);
      if (!/^\d+[\\/]media_\d+\.(?:png|jpg|jpeg|webp|gif)$/.test(relative)) return false;
      try {
        if (await fs.realpath(target) !== target) return false;
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return false;
        return images.has(digest(await fs.readFile(target)));
      } catch { return false; }
    }
  };
}
