import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { toMcpContent } from './mcp-content.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Only images returned by this run may be read from the CLI's media spool. */
export function createRunImageAccess({ home = os.homedir(), workspace } = {}) {
  const images = new Set();
  const files = new Map();
  return {
    async materialize(content) {
      if (!workspace || !Array.isArray(content)) return content;
      const parts = [];
      for (const part of toMcpContent(content)) {
        if (part.type !== 'image') { parts.push(part); continue; }
        const bytes = Buffer.from(part.data, 'base64');
        if (!bytes.length || bytes.length > 4 * 1024 * 1024 || files.size >= 32) {
          parts.push({ type: 'text', text: '图片超出本轮安全读取限制，未传入模型；不要声称已经看到。' });
          continue;
        }
        const dir = path.join(workspace, '.qq-images');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${randomUUID()}.${part.mimeType === 'image/jpeg' ? 'jpg' : part.mimeType.slice(6)}`);
        await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
        files.set(file, digest(bytes));
        parts.push({ type: 'text', text: `本轮图片已准备好。请用 read_file 查看 ${JSON.stringify({ Path: file })}；这一次经内容校验的图片读取无需管理员审批。未读取前不要声称已经看过。` });
      }
      return parts;
    },
    observe(content) {
      for (const part of toMcpContent(content)) {
        if (part.type !== 'image' || images.size >= 32) continue;
        const bytes = Buffer.from(part.data, 'base64');
        if (bytes.length && bytes.length <= 4 * 1024 * 1024) images.add(digest(bytes));
      }
    },
    async allows(file, sessionId) {
      if ((!images.size && !files.size) || typeof file !== 'string' || !path.isAbsolute(file)
        || !/^[a-f0-9-]{36}$/i.test(sessionId || '')) return false;
      const root = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'steps');
      const target = path.resolve(file), relative = path.relative(root, target);
      if (!files.has(target) && !/^\d+[\\/]media_\d+\.(?:png|jpg|jpeg|webp|gif)$/.test(relative)) return false;
      try {
        if (await fs.realpath(target) !== target) return false;
        const stat = await fs.stat(target);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return false;
        const actual = digest(await fs.readFile(target));
        return files.has(target) ? files.get(target) === actual : images.has(actual);
      } catch { return false; }
    }
  };
}
