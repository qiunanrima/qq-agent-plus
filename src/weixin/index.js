import { WeixinRuntime } from './runtime.js';
import { chatCompletion } from '../llm/llm.js';
import { antigravityCompletion } from '../antigravity-cli/index.js';
import { resolvePersona } from '../personas.js';
import { isTimeActive } from '../core/time-gate.js';

export function createWeixinFeature({ dataDir, getConfig, memory, background, personalityMemory, isPaused }) {
  const active = () => getConfig().weixin?.enabled === true && getConfig().runtime?.mode === 'active' && !isPaused() && isTimeActive();
  return new WeixinRuntime({ dataDir, getConfig, canRespond: active,
    persona: chatKey => {
      const persona = resolvePersona(getConfig(), chatKey);
      const traits = getConfig().personalityMemory?.enabled ? personalityMemory.recallRows({ chatKey, persona })
        .filter(row => row.kind === 'preference' && row.status === 'active').slice(0, 10).map(row => row.content).join('\n') : '';
      return [`【共享角色卡】${persona.roleText || ''}`, `【共享角色背景】${background.read(persona).content.slice(0, 24000)}`,
        traits ? `【共享人格偏好】${traits}` : ''].filter(Boolean).join('\n\n');
    },
    readPerson: qqId => ({ impressions: memory.query(`private:${qqId}`, 'memberImpression').memberImpression.filter(row => String(row.userId) === qqId).slice(0, 40) }),
    appendPerson: (chatKey, qqId, content) => memory.append(chatKey, 'memberImpression', content, { userId: qqId, target: memory.getMember('', qqId).name || qqId }),
    model: async ({ nativeApproval, ...args }) => {
      if (!active()) throw new Error('微信回复当前已暂停');
      const cli = getConfig().antigravityCli;
      if (!cli?.enabled) return chatCompletion(args);
      return antigravityCompletion({ ...args, config: { ...cli, qqApproval: false, nativeApproval: nativeApproval && cli.nativeApproval },
        isEnabled: () => active() && getConfig().antigravityCli?.enabled === true });
    }
  });
}
