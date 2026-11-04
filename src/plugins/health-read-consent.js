// Derive notification exemption from the current owner trigger, never tool arguments.
export function explicitHealthRead(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s || /不要|别查|不许|禁止|不允许|不能|不想|别读|不用查|无需|别读取|别获取/.test(s)) return null;
  if (!/查|读取|获取|看看|看一下|告诉我|多少|怎么样|如何|可以看|允许/.test(s)) return null;
  const metrics = [];
  if (/步数|走了几步|走了多少步/.test(s)) metrics.push('steps');
  if (/睡眠|睡了多久|睡得|睡了几/.test(s)) metrics.push('sleep');
  if (/心率|心跳/.test(s)) metrics.push('heart_rate');
  if (/健康数据|健康摘要/.test(s)) metrics.push('steps', 'sleep', 'heart_rate');
  if (!metrics.length) return null;
  const daysMatch = s.match(/(?:最近|过去|近)\s*([1-7])\s*天/);
  if (/上周|一周|七天|7天/.test(s) && !daysMatch) return null;
  return { metrics: [...new Set(metrics)], days: daysMatch ? Number(daysMatch[1]) : 1 };
}
