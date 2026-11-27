import yauzl from 'yauzl';
import { MAX_TOTAL_UNPACKED, unsafePathSegment } from './install.js';

export async function readOpenClawZip(buffer) {
  const archive = await yauzl.fromBufferPromise(buffer, {
    strictFileNames: true, validateEntrySizes: true
  });
  try {
    if (!archive.entryCount || archive.entryCount > 4000) throw new Error('ZIP 条目数量无效');
    const entries = [];
    const names = new Set();
    let total = 0;
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const folded = name.toLowerCase();
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (name.split('/').some(unsafePathSegment) || names.has(folded)
          || (mode && mode !== (directory ? 0o040000 : 0o100000))) {
        throw new Error('ZIP 包含无效路径、重复条目或特殊文件');
      }
      names.add(folded);
      total += entry.uncompressedSize;
      if (total > MAX_TOTAL_UNPACKED) throw new Error('ZIP 解包后体积超过上限');
      if (directory) {
        if (entry.uncompressedSize) throw new Error('ZIP 目录不能包含文件内容');
        entries.push({ name, type: 'dir', data: null });
        continue;
      }
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      entries.push({ name, type: 'file', data: Buffer.concat(chunks) });
    }
    return entries;
  } finally {
    archive.close();
  }
}
