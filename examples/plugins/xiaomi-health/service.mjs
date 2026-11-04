import { HealthError } from './errors.mjs';
import { XiaomiClient } from './client.mjs';
import qrcode from './qrcode.js';

function qrDataUrl(value) {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const paths = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (qr.isDark(y, x)) paths.push(`M${x + 4},${y + 4}h1v1h-1z`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${n + 8}v${n + 8}H0z"/><path fill="black" d="${paths.join('')}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const FIELDS = {
  steps: ['steps', 'distance', 'calories', 'goal'],
  sleep: ['total_duration', 'sleep_score', 'sleep_deep_duration', 'sleep_light_duration',
    'sleep_rem_duration', 'sleep_awake_duration', 'avg_hr', 'avg_spo2'],
  heart_rate: ['avg_hr', 'avg_rhr', 'max_hr', 'min_hr']
};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function normalizeMetric(item, metric) {
  let value;
  try { value = typeof item.value === 'string' ? JSON.parse(item.value) : item.value; } catch { value = {}; }
  const out = { time: finite(item.time), updatedAt: finite(item.update_time) };
  for (const key of FIELDS[metric]) out[key] = finite(value?.[key]);
  if (metric === 'heart_rate') out.latest_hr = value?.latest_hr ? {
    bpm: finite(value.latest_hr.bpm), time: finite(value.latest_hr.time)
  } : null;
  return out;
}

export function createHealthService(callHost, now = Date.now) {
  const client = new XiaomiClient(params => callHost('cap.http.request', params),
    session => callHost('cap.secrets.set', { values: { session } }), now);
  async function ready({ agentRead = false } = {}) {
    const config = await callHost('cap.config.get', {});
    if (config?.settings?.acceptUnofficial !== true) {
      client.login = null;
      client.token = null;
      throw new HealthError('请先勾选「已了解并启用非官方接口」，点击「保存设置」后再扫码');
    }
    if (agentRead && config?.settings?.allowAgentRead !== true) return false;
    const secrets = await callHost('cap.secrets.get', {});
    client.load(secrets?.values?.session || '');
    return true;
  }
  function authorize(context) {
    if (context?.channel === 'console') return;
    if (context?.senderIsOwner !== true || !/^private:\d+$/.test(context?.chatKey || '')) {
      throw new HealthError('健康数据仅允许管理员在私聊或控制台查询，群聊不可用');
    }
  }
  async function probe() {
    await ready();
    if (!client.token) return { login: false, note: '尚未扫码登录' };
    await client.aggregate('steps', 1);
    return { login: true, uname: '小米运动健康（中国区）', measuredAt: now() };
  }
  return {
    probe,
    async call(name, args = {}, context = {}) {
      // Authorization comes exclusively from host context, never from model-provided arguments.
      authorize(context);
      if (name === 'login') {
        if (context.channel !== 'console') throw new HealthError('请打开控制台→插件→小米运动健康管理登录');
        if (args.action === 'logout') {
          client.login = null;
          client.token = null;
          client.cookies.clear();
          await callHost('cap.secrets.set', { values: { session: '' } });
          return { ok: true, note: '已清除本地凭据；不代表撤销小米端登录' };
        }
        await ready();
        if (args.action === 'status') return { ok: true, ...await probe() };
        if (args.action === 'start') {
          const { loginUrl, expiresIn } = await client.start();
          return { ok: true, channel: 'console', qrcodeDataUrl: qrDataUrl(loginUrl), expiresIn,
            note: '用小米运动健康 App 扫码并确认登录，仅支持中国区账号。' };
        }
        if (args.action === 'poll') {
          const state = await client.poll();
          if (state.state !== 'done') return { ok: true, ...state };
          try { await probe(); }
          catch { return { ok: true, state: 'unverified', note: '凭据已加密保存，但健康接口校验失败，请检测登录或重新扫码' }; }
          return { ok: true, state: 'done', account: '小米运动健康（中国区）' };
        }
        throw new HealthError('不支持的账号操作');
      }
      if (name !== 'query') throw new HealthError('未知健康工具');
      const rawMetric = args.metric ?? 'all';
      const aliases = { heartRate: 'heart_rate', heartrate: 'heart_rate', 'heart-rate': 'heart_rate',
        '步数': 'steps', '睡眠': 'sleep', '心率': 'heart_rate', '全部': 'all' };
      const metric = typeof rawMetric === 'string' ? (aliases[rawMetric.trim()] || rawMetric.trim().toLowerCase()) : rawMetric;
      const rawDays = args.days ?? 1;
      const days = typeof rawDays === 'string' && /^\s*[1-7]\s*$/.test(rawDays) ? Number(rawDays) : rawDays;
      if (!['steps', 'sleep', 'heart_rate', 'all'].includes(metric)
        || !Number.isInteger(days) || days < 1 || days > 7) return {
          ok: false, code: 'E_ARGS', error: '查询参数无效：metric 只能是 steps、sleep、heart_rate、all；days 为1至7的整数，省略为1。请修正参数。',
          example: { metric: 'all', days: 1 }
        };
      const agentRead = context.channel !== 'console';
      if (!await ready({ agentRead })) return {
        ok: false, code: 'E_READ_DISABLED',
        error: '管理员尚未授权 Agent 读取健康数据，请在插件设置开启「允许 Agent 读取健康数据」。不要重复调用。'
      };
      if (!client.token) throw new HealthError('请先在控制台扫码登录小米运动健康');
      const requestedMetrics = metric === 'all' ? Object.keys(FIELDS) : [metric];
      const consent = context.explicitHealthRead;
      const explicitlyRequested = consent && Number.isInteger(consent.days) && days <= consent.days
        && Array.isArray(consent.metrics) && requestedMetrics.every(key => consent.metrics.includes(key));
      if (agentRead && !explicitlyRequested) {
        const names = { steps: '步数', sleep: '睡眠', heart_rate: '心率', all: '步数、睡眠、心率' };
        try {
          await callHost('cap.send.text', { chatKey: context.chatKey,
            text: `【小米健康 · 数据读取提示】\nAgent 正在读取管理员本人的${names[metric]}（最近 ${days} 天）。\n来源：小米运动健康插件，非 Agent 生成。\n关闭读取：控制台 → 插件 → 小米运动健康 → 关闭「允许 Agent 读取健康数据」。` });
        } catch {
          return { ok: false, code: 'E_NOTICE_FAILED', error: '管理员读取提示发送失败，本次未读取健康数据。不要自动重试。' };
        }
      }
      const metrics = metric === 'all' ? Object.keys(FIELDS) : [metric];
      const data = {};
      for (const key of metrics) data[key] = (await client.aggregate(key, days)).map(item => normalizeMetric(item, key));
      return { ok: true, timezone: 'Asia/Shanghai', fetchedAt: new Date(now()).toISOString(), days, data,
        units: { timestamps: 'Unix秒', sleepDuration: '分钟', heartRate: '次/分钟' },
        note: '仅反映云端已同步数据；空数组表示无可读记录，不等于数值为0。不得据此推断实时睡眠状态或疾病。' };
    }
  };
}
