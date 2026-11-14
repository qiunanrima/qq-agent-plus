import { skillGateMessage } from '../skills/registry.js';

export const ON_DEMAND_TOOL_GROUPS = {
  account: ['set_my_signature', 'set_my_status', 'set_my_avatar', 'set_my_profile', 'set_remark', 'set_member_note'],
  files: ['list_group_files', 'group_file_url', 'send_group_file', 'send_private_file'],
  albums: ['list_group_album', 'like_album_photo', 'comment_album_photo', 'upload_to_group_album'],
  management: ['get_group_profile', 'group_sign', 'set_group_todo', 'set_group_card', 'set_group_ban', 'kick_group_member', 'recall_message', 'set_group_admin', 'get_group_member_list']
};

// Operates on the already-filtered, per-run catalog. Discovery never grants
// a disabled capability and never executes an external action.
export function mountOnDemandTools(defs, execute, allowed = () => true) {
  const names = new Set(Object.values(ON_DEMAND_TOOL_GROUPS).flat());
  const deferred = defs.filter(def => names.has(def.name));
  if (!deferred.length) return defs;
  const loaded = new Set();
  const fail = message => ({ content: message, isError: true, noEffect: true, reportIncident: false });
  const groups = Object.entries(ON_DEMAND_TOOL_GROUPS)
    .filter(([, names]) => deferred.some(def => names.includes(def.name))).map(([group]) => group);
  return [...defs.filter(def => !names.has(def.name)), {
    name: 'discover_tools',
    description: `按需使用低频工具：account=账号签名/状态/头像/昵称/备注；files=文件；albums=相册；management=群资料/签到/待办/名片/成员/禁言/踢人/管理员/撤回。可用分类：${groups.join(', ')}。先传 group 查询可用工具和完整参数（不执行）；再传 tool 和 args 执行已查询工具。同一处理周期只需查询一次。功能开关、场景、权限和审批仍生效；写入结果未知不可重试。`,
    parameters: { type: 'object', properties: {
      group: { type: 'string', enum: groups },
      tool: { type: 'string', description: '已查询的工具名；执行时不传 group' },
      args: { type: 'object', description: '该工具的参数' }
    }, additionalProperties: false },
    async execute(ctx, args) {
      if (args.group && args.tool) return fail('查询 group 和执行 tool 必须分开调用，未执行动作');
      if (args.group) {
        const wanted = ON_DEMAND_TOOL_GROUPS[args.group] || [];
        const available = deferred.filter(def => wanted.includes(def.name) && allowed(def)
          && !skillGateMessage(ctx.activeSkill, ctx.pendingSkillUse, def.name));
        available.forEach(def => loaded.add(def.name));
        return { content: JSON.stringify({ tools: available.map(({ name, description, parameters }) => ({ name, description, parameters })) }) };
      }
      const def = deferred.find(def => def.name === args.tool);
      if (!def || !loaded.has(def.name) || !allowed(def)) return fail('工具未查询、已关闭或当前会话不可用，请先传 group 查询；未执行动作');
      const gate = skillGateMessage(ctx.activeSkill, ctx.pendingSkillUse, def.name, args.args);
      if (gate) return fail(gate);
      const result = await execute(deferred, ctx, def.name, JSON.stringify(args.args ?? {}));
      return { ...result, resolvedTool: def.name };
    }
  }];
}
