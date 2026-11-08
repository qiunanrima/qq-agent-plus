import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { imageType } from '../core/image-type.js';
import { convertGifToStillStrip, convertStillImageToJpeg } from '../tools/image-downsample.js';

// Resolve only media belonging to a stored message in this whitelisted DM.
export async function readWechatImages(runtime, key, ctx, args = {}) {
  const ids = Object.hasOwn(args, 'messageId') ? [args.messageId] : args.messageIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 4 || ids.some(id => typeof id !== 'string' || id.length > 2048))
    return { isError: true, content: '请传当前微信会话的 messageId 或最多四个 messageIds。' };
  const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(20000)]);
  const scope = runtime.config();
  const guard = () => {
    signal.throwIfAborted();
    if (!runtime.allowed(key) || runtime.config().accountId !== scope.accountId) throw new Error('微信会话已停止或账号已改变');
  };
  const request = async (route, options = {}) => { guard(); const value = await runtime.api.request(route, { ...options, signal }); guard(); return value; };
  const content = []; let isError = false;
  for (const id of new Set(ids)) {
    try {
      guard();
      const entry = runtime.store.findByMid(key, id);
      if (!entry || !entry.media?.some(m => m.kind === 'image' && m.channel === 'wechat')) throw new Error('当前微信会话找不到该图片消息');
      const message = await request(`/messages/${encodeURIComponent(id)}`);
      if (message.recall || message.type === 10000) throw Object.assign(new Error('微信消息已撤回或已变为系统通知，原图片不可读取。'), { publicReason: true });
      if (message.threadId !== runtime.peer(key) || message.direction !== 'incoming' || ![3, 47].includes(message.type)
        || message.senderId && message.senderId !== (entry.senderId || (key.startsWith('private:') ? runtime.peer(key) : ''))) throw new Error('微信图片消息身份不匹配');
      const assets = async () => {
        const page = await request(`/messages/${encodeURIComponent(id)}/media`);
        if (!Array.isArray(page.items) || page.items.some(a => a.accountId !== scope.accountId || a.messageId !== id)) throw new Error('微信媒体身份不匹配');
        return page.items;
      };
      const select = rows => [...rows].sort((a, b) => ['original', 'standard', 'encoded', 'thumbnail'].indexOf(a.actualVariant || a.variant)
        - ['original', 'standard', 'encoded', 'thumbnail'].indexOf(b.actualVariant || b.variant)).find(a => a.state === 'available');
      let asset = select(await assets());
      if (!asset) {
        let job = runtime.mediaJobs.get(id);
        if (!job) {
          if (runtime.mediaJobs.size >= 128) throw new Error('微信媒体下载队列已满');
          runtime.mediaJobs.set(id, { state: 'unknown' });
          job = await request(`/messages/${encodeURIComponent(id)}/media-transfers`, { body: { messageId: id, quality: 'best' } });
          runtime.mediaJobs.set(id, job);
        }
        if (!job.id) throw new Error('微信媒体下载状态未知，未重新提交');
        for (let i = 0; i < 30; i++) {
          if (job.accountId !== scope.accountId || job.kind !== 'download') throw new Error('微信下载任务身份不匹配');
          asset = select(await assets());
          if (asset) break;
          if (['failed', 'cancelled', 'expired', 'needs_review', 'completed', 'succeeded', 'available'].includes(job.state)) break;
          await delay(400, null, { signal });
          job = await request(`/jobs/${encodeURIComponent(job.id)}`);
          if (job.id !== runtime.mediaJobs.get(id).id) throw new Error('微信下载任务已改变');
        }
      }
      if (!asset || !/^[A-Za-z0-9_-]{1,200}$/.test(asset.id) || asset.byteLength > 12 * 1024 * 1024) throw new Error('微信图片未就绪或超过大小限制');
      const bytes = await request(`/media/${asset.id}/content`, { binary: true });
      if (asset.sha256 && createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('微信图片内容校验失败');
      let mime = imageType(bytes), prepared = bytes;
      if (!mime) throw new Error('微信媒体不是支持的图片格式');
      const animated = mime === 'image/gif';
      if (animated) { prepared = await convertGifToStillStrip(bytes, signal); mime = 'image/jpeg'; }
      else if (bytes.length > 4 * 1024 * 1024) { prepared = await convertStillImageToJpeg(bytes, signal); mime = 'image/jpeg'; }
      guard();
      if (!prepared?.length || prepared.length > 4 * 1024 * 1024) throw new Error('微信图片转换失败或超出模型大小限制');
      runtime.mediaJobs.delete(id);
      content.push({ type: 'text', text: `微信消息 ${id} 的图片${animated ? '：动图按时间抽成 2×2 四帧，顺序左上、右上、左下、右下；黑格为填充' : ''}。判断情绪和含义后回复，不要编造未看见的内容。` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${prepared.toString('base64')}` } });
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      isError = true;
      content.push({ type: 'text', text: error.publicReason ? error.message + ' 不要声称已看见；如已如实回复可用 errorAcknowledged:true 结束。'
        : '微信图片或表情包未能读取（可能尚未下载或协议不支持该来源）；不要声称已看见，也不要换用 QQ 或原生文件工具查找。' });
    }
  }
  return { content, isError: isError && !content.some(part => part.type === 'image_url') };
}
