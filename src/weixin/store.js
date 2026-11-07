import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Lazy, module-owned journal. Unknown sends are retained and never replayed. */
export class WeixinStore {
  constructor(dir) { this.file = path.join(dir, 'weixin', 'state.json'); this.state = null; }
  read() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.state || typeof this.state !== 'object' || !this.state.peers || !Array.isArray(this.state.seen)
        || !Array.isArray(this.state.outbox) || !Array.isArray(this.state.runs)) throw new Error('Invalid state');
      for (const run of this.state.runs) if (run.status === 'running') { run.status = 'interrupted'; run.error = '服务重启中断；未重试'; }
    }
    catch (error) { this.state = null; if (error.code !== 'ENOENT') throw new Error('微信数据无法读取，保留原文件，请先修复'); }
    return this.state ||= { account: null, peers: {}, seen: [], outbox: [], cursor: '', runs: [] };
  }
  save() {
    const data = this.read();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flush: true });
      fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  resetAccount(account) {
    const state = this.read();
    if (state.account && state.account.id !== account.id) throw new Error('已有其他微信账号；请先解除账号连接');
    state.account = account; this.save();
  }
  snapshot() {
    const state = this.read();
    return { account: state.account ? { id: state.account.id, owner: state.account.owner } : null,
      peers: Object.entries(state.peers).filter(([, p]) => p.accountId === state.account?.id).map(([id, p]) => ({ id, userId: p.userId, enabled: !!p.enabled, nativeApproval: !!p.nativeApproval, qqId: p.qqId || '', lastAt: p.lastAt, summary: p.summary || '' })),
      runs: state.runs.slice(-30).map(({ id, status, at, seconds, error }) => ({ id, status, at, seconds, error })),
      unknownSends: state.outbox.filter(item => item.state === 'unknown').length,
      unknownOutbox: state.outbox.filter(item => item.state === 'unknown').slice(-50).map(item => ({ id: item.id, at: item.at,
        canResolve: state.runs.find(run => run.id === item.runId)?.status !== 'running' })) };
  }
}
