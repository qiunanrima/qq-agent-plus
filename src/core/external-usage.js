import fs from 'node:fs';
import path from 'node:path';
import { todayKey } from './util.js';

export function appendExternalUsage(dataDir, row) {
  const dir = path.join(dataDir, 'external-usage');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, `${todayKey(row.at)}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
export function externalUsageSignature(dataDir) {
  const dir = path.join(dataDir, 'external-usage');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`).join('|'); }
  catch { return ''; }
}
export function readExternalUsage(dataDir, win) {
  const dir = path.join(dataDir, 'external-usage');
  const rows = [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return rows; }
  for (const file of files) {
    if (file.slice(0, 10) < todayKey(win.start) || file.slice(0, 10) > todayKey(win.end)) continue;
    let content;
    try { content = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      try {
        const row = JSON.parse(line);
        if (row.at >= win.start && row.at <= win.end) rows.push(row);
      } catch { /* 未完成的末行不影响其它调用 */ }
    }
  }
  return rows;
}
