// Channel capabilities are registered by adapters, never inferred from a QQ ID.
const adapters = new Map();
export const isWechatChat = key => /^(?:private|group):wechat_[a-f0-9]{64}$/.test(String(key));
export function channelForChat(key) {
  if (!isWechatChat(key)) return null;
  return adapters.get('wechat') || null;
}
export function registerChannel(name, adapter) {
  if (name !== 'wechat' || adapters.has(name)) throw new Error('Channel already registered or unsupported');
  adapters.set(name, adapter);
  return () => { if (adapters.get(name) === adapter) adapters.delete(name); };
}
